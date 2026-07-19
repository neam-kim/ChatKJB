import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
});

function startMcp(env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  const child = spawn("/usr/bin/python3", [resolve("scripts/literature-evidence-mcp.py")], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.push(child);
  return child;
}

function rpc(
  child: ChildProcessWithoutNullStreams,
  message: Record<string, unknown>
): Promise<Record<string, any>> {
  return new Promise((resolveReply, reject) => {
    const id = message.id;
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("MCP response timeout"));
    }, 5_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const payload = JSON.parse(line) as Record<string, any>;
        if (payload.id !== id) continue;
        cleanup();
        resolveReply(payload);
        return;
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function toolPayload(response: Record<string, any>): Record<string, any> {
  return JSON.parse(response.result.content[0].text) as Record<string, any>;
}

describe("literature evidence MCP", () => {
  it("advertises paper and clinical-trial search tools", async () => {
    const child = startMcp();
    const initialized = await rpc(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const listed = await rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    expect(initialized.result.serverInfo.name).toBe("literature-evidence");
    expect(listed.result.tools.map((tool: { name: string; }) => tool.name)).toEqual([
      "search_papers",
      "search_clinical_trials"
    ]);
  });

  it("normalizes public paper and trial records into Elicit-compatible fields", async () => {
    const base = await listen(createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/graph/v1/paper/search") {
        expect(url.searchParams.get("query")).toBe("GLP-1 cardiovascular outcomes");
        expect(url.searchParams.get("year")).toBe("2020-2026");
        response.end(JSON.stringify({
          total: 1,
          data: [{
            paperId: "paper-1",
            title: "Cardiovascular outcomes with GLP-1 receptor agonists",
            abstract: "A randomized trial abstract.",
            authors: [{ name: "Kim J" }, { name: "Lee A" }],
            year: 2024,
            publicationDate: "2024-05-01",
            venue: "Example Journal",
            externalIds: { DOI: "10.1000/example", PubMed: "12345678" },
            citationCount: 42,
            referenceCount: 30,
            isOpenAccess: true,
            openAccessPdf: { url: "https://example.org/paper.pdf" },
            url: "https://www.semanticscholar.org/paper/paper-1",
            publicationTypes: ["ClinicalTrial"]
          }]
        }));
        return;
      }
      if (url.pathname === "/api/v2/studies") {
        expect(url.searchParams.get("query.term")).toBe("GLP-1 cardiovascular outcomes");
        response.end(JSON.stringify({
          totalCount: 1,
          studies: [{
            hasResults: true,
            protocolSection: {
              identificationModule: { nctId: "NCT01234567", briefTitle: "GLP-1 outcomes trial" },
              descriptionModule: { briefSummary: "Trial summary" },
              statusModule: {
                overallStatus: "COMPLETED",
                startDateStruct: { date: "2020-01-01" },
                primaryCompletionDateStruct: { date: "2023-01-01" },
                completionDateStruct: { date: "2023-06-01" },
                studyFirstPostDateStruct: { date: "2019-12-01" },
                lastUpdatePostDateStruct: { date: "2024-02-03" }
              },
              designModule: {
                phases: ["PHASE3"],
                studyType: "INTERVENTIONAL",
                enrollmentInfo: { count: 500 }
              },
              conditionsModule: { conditions: ["Cardiovascular Disease"] },
              armsInterventionsModule: { interventions: [{ name: "Semaglutide" }] },
              sponsorCollaboratorsModule: { leadSponsor: { name: "Example University" } }
            }
          }]
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }));
    const child = startMcp({
      SEMANTIC_SCHOLAR_API_BASE: `${base}/graph/v1`,
      CLINICAL_TRIALS_API_BASE: `${base}/api/v2`
    });

    const paperResponse = await rpc(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_papers",
        arguments: { query: "GLP-1 cardiovascular outcomes", min_year: 2020, max_year: 2026 }
      }
    });
    const trialResponse = await rpc(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "search_clinical_trials",
        arguments: { query: "GLP-1 cardiovascular outcomes" }
      }
    });

    const papers = toolPayload(paperResponse);
    const trials = toolPayload(trialResponse);
    expect(papers.fallbackUsed).toBe(false);
    expect(papers.papers[0]).toMatchObject({
      title: "Cardiovascular outcomes with GLP-1 receptor agonists",
      authors: ["Kim J", "Lee A"],
      doi: "10.1000/example",
      pmid: "12345678",
      citedByCount: 42,
      openAccessPdf: "https://example.org/paper.pdf"
    });
    expect(trials.trials[0]).toMatchObject({
      nctId: "NCT01234567",
      overallStatus: "COMPLETED",
      phase: ["PHASE3"],
      enrollmentCount: 500,
      interventions: ["Semaglutide"],
      hasResults: true,
      lastUpdatedYear: 2024
    });
  });

  it("falls back to OpenAlex when the unauthenticated Semantic Scholar pool is throttled", async () => {
    const base = await listen(createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/graph/v1/paper/search") {
        response.statusCode = 429;
        response.end(JSON.stringify({ message: "Too Many Requests" }));
        return;
      }
      if (url.pathname === "/works") {
        expect(url.searchParams.get("search")).toBe("CRISPR cancer therapy");
        expect(url.searchParams.get("filter")).toContain("from_publication_date:2023-01-01");
        response.end(JSON.stringify({
          meta: { count: 1 },
          results: [{
            id: "https://openalex.org/W123",
            doi: "https://doi.org/10.1000/openalex",
            display_name: "CRISPR in cancer therapy",
            publication_year: 2025,
            publication_date: "2025-01-10",
            cited_by_count: 12,
            abstract_inverted_index: { CRISPR: [0], therapy: [2], cancer: [1] },
            authorships: [{ author: { display_name: "Example Author" } }],
            primary_location: {
              landing_page_url: "https://example.org/article",
              source: { display_name: "Example Oncology" }
            },
            best_oa_location: { pdf_url: "https://example.org/article.pdf" },
            open_access: { is_oa: true },
            ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/87654321" },
            referenced_works: ["https://openalex.org/W1"],
            type: "article"
          }]
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }));
    const child = startMcp({
      SEMANTIC_SCHOLAR_API_BASE: `${base}/graph/v1`,
      OPENALEX_API_BASE: base
    });

    const response = await rpc(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_papers",
        arguments: { query: "CRISPR cancer therapy", limit: 1, min_year: 2023 }
      }
    });
    const payload = toolPayload(response);

    expect(payload).toMatchObject({
      ok: true,
      source: "OpenAlex (Semantic Scholar fallback)",
      fallbackUsed: true,
      totalEstimated: 1
    });
    expect(payload.papers[0]).toMatchObject({
      title: "CRISPR in cancer therapy",
      abstract: "CRISPR cancer therapy",
      authors: ["Example Author"],
      doi: "10.1000/openalex",
      pmid: "87654321",
      citedByCount: 12,
      openAccessPdf: "https://example.org/article.pdf"
    });
  });
});
