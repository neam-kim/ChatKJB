#!/usr/bin/env python3
"""Minimal Scanpy-backed MCP server for single-cell RNA-seq analysis."""

from __future__ import annotations

import json
import sys
from importlib.metadata import version
from pathlib import Path
from typing import Any

try:
    import scanpy as sc
except Exception as exc:  # pragma: no cover - environment dependent
    sc = None
    _SCANPY_IMPORT_ERROR = exc
else:
    _SCANPY_IMPORT_ERROR = None

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "scanpy"
SERVER_VERSION = "1.0.0"


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    print(f"[scanpy-tools-mcp] {message}", file=sys.stderr, flush=True)


def text_result(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": [
            {"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}
        ]
    }


def error_result(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], "isError": True}


TOOLS: list[dict[str, Any]] = [
    {
        "name": "scanpy_info",
        "description": "Report Scanpy availability and version for this MCP server.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "scanpy_inspect",
        "description": (
            "Read a single-cell dataset with Scanpy and return compact AnnData metadata. "
            "Supported formats: h5ad, 10x_mtx directory, 10x_h5, loom, csv, tsv, mtx."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Dataset path."},
                "format": {
                    "type": "string",
                    "description": "auto, h5ad, 10x_mtx, 10x_h5, loom, csv, tsv, or mtx.",
                    "default": "auto",
                },
            },
            "required": ["path"],
        },
    },
    {
        "name": "scanpy_preprocess_cluster",
        "description": (
            "Run a conservative Scanpy preprocessing and clustering workflow: QC metrics, "
            "cell/gene filtering, normalize_total, log1p, highly variable genes, scale, "
            "PCA, neighbors, UMAP, and Leiden when the optional dependency is available. "
            "Writes the processed AnnData and QC tables to disk."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Input dataset path."},
                "format": {
                    "type": "string",
                    "description": "auto, h5ad, 10x_mtx, 10x_h5, loom, csv, tsv, or mtx.",
                    "default": "auto",
                },
                "output_dir": {
                    "type": "string",
                    "description": "Output directory. Defaults to '<input>.scanpy/'.",
                },
                "min_genes": {"type": "integer", "default": 200},
                "min_cells": {"type": "integer", "default": 3},
                "target_sum": {"type": "number", "default": 10000},
                "n_top_genes": {"type": "integer", "default": 2000},
                "n_pcs": {"type": "integer", "default": 50},
                "n_neighbors": {"type": "integer", "default": 15},
                "leiden_resolution": {"type": "number", "default": 1.0},
            },
            "required": ["path"],
        },
    },
    {
        "name": "scanpy_rank_markers",
        "description": (
            "Run scanpy.tl.rank_genes_groups on an AnnData file and save marker tables. "
            "Use a categorical obs column such as leiden, cell_type, or treatment."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Input .h5ad path."},
                "groupby": {"type": "string", "description": "obs column to group cells by."},
                "method": {
                    "type": "string",
                    "description": "wilcoxon, t-test, t-test_overestim_var, or logreg.",
                    "default": "wilcoxon",
                },
                "output_dir": {
                    "type": "string",
                    "description": "Output directory. Defaults to '<input>.scanpy/'.",
                },
            },
            "required": ["path", "groupby"],
        },
    },
]


def resolve_path(path_str: str) -> Path:
    path = Path(path_str).expanduser()
    if not path.is_absolute():
        path = path.resolve()
    if not path.exists():
        raise FileNotFoundError(f"Path not found: {path}")
    return path


def default_output_dir(path: Path) -> Path:
    if path.is_dir():
        return path / "scanpy-output"
    return path.with_suffix(".scanpy")


def read_adata(path_str: str, fmt: str | None = None):
    path = resolve_path(path_str)
    fmt = (fmt or "auto").lower()
    if fmt == "auto":
        if path.is_dir():
            fmt = "10x_mtx"
        elif path.suffix == ".h5ad":
            fmt = "h5ad"
        elif path.suffix == ".h5":
            fmt = "10x_h5"
        elif path.suffix == ".loom":
            fmt = "loom"
        elif path.suffix == ".csv":
            fmt = "csv"
        elif path.suffix == ".tsv":
            fmt = "tsv"
        elif path.suffix == ".mtx":
            fmt = "mtx"
        else:
            raise ValueError(f"Cannot infer input format from: {path}")

    if fmt == "h5ad":
        adata = sc.read_h5ad(path)
    elif fmt == "10x_mtx":
        adata = sc.read_10x_mtx(path, var_names="gene_symbols", cache=False)
    elif fmt == "10x_h5":
        adata = sc.read_10x_h5(path)
    elif fmt == "loom":
        adata = sc.read_loom(path)
    elif fmt == "csv":
        adata = sc.read_csv(path)
    elif fmt == "tsv":
        adata = sc.read_text(path, delimiter="\t")
    elif fmt == "mtx":
        adata = sc.read_mtx(path)
    else:
        raise ValueError(f"Unsupported format: {fmt}")

    adata.var_names_make_unique()
    return adata, path, fmt


def summarize_adata(adata, path: Path, fmt: str) -> dict[str, Any]:
    return {
        "ok": True,
        "path": str(path),
        "format": fmt,
        "n_obs": int(adata.n_obs),
        "n_vars": int(adata.n_vars),
        "obs_columns": [str(x) for x in adata.obs.columns[:50]],
        "var_columns": [str(x) for x in adata.var.columns[:50]],
        "layers": [str(x) for x in adata.layers.keys()],
        "obsm": [str(x) for x in adata.obsm.keys()],
        "uns": [str(x) for x in adata.uns.keys()],
        "first_obs_names": [str(x) for x in adata.obs_names[:5]],
        "first_var_names": [str(x) for x in adata.var_names[:10]],
    }


def add_mito_qc_flag(adata) -> list[str]:
    names = adata.var_names.astype(str)
    mt = names.str.startswith("MT-") | names.str.startswith("mt-")
    adata.var["mt"] = mt
    return ["mt"] if bool(mt.any()) else []


def tool_scanpy_info(_args: dict[str, Any]) -> dict[str, Any]:
    if sc is None:
        return text_result(
            {
                "ok": False,
                "scanpy_available": False,
                "error": str(_SCANPY_IMPORT_ERROR),
                "install_hint": "Install Scanpy in the Python environment used by this MCP server.",
            }
        )
    return text_result({"ok": True, "scanpy_available": True, "version": version("scanpy")})


def tool_scanpy_inspect(args: dict[str, Any]) -> dict[str, Any]:
    adata, path, fmt = read_adata(str(args.get("path", "")), args.get("format"))
    return text_result(summarize_adata(adata, path, fmt))


def tool_scanpy_preprocess_cluster(args: dict[str, Any]) -> dict[str, Any]:
    adata, path, fmt = read_adata(str(args.get("path", "")), args.get("format"))
    out_dir = Path(str(args["output_dir"])) if args.get("output_dir") else default_output_dir(path)
    out_dir.mkdir(parents=True, exist_ok=True)

    min_genes = int(args.get("min_genes", 200) or 200)
    min_cells = int(args.get("min_cells", 3) or 3)
    target_sum = float(args.get("target_sum", 10000) or 10000)
    n_top_genes = int(args.get("n_top_genes", 2000) or 2000)
    n_pcs = int(args.get("n_pcs", 50) or 50)
    n_neighbors = int(args.get("n_neighbors", 15) or 15)
    leiden_resolution = float(args.get("leiden_resolution", 1.0) or 1.0)

    before = (int(adata.n_obs), int(adata.n_vars))
    qc_vars = add_mito_qc_flag(adata)
    sc.pp.calculate_qc_metrics(adata, qc_vars=qc_vars, percent_top=None, log1p=False, inplace=True)
    sc.pp.filter_cells(adata, min_genes=min_genes)
    sc.pp.filter_genes(adata, min_cells=min_cells)
    after_filter = (int(adata.n_obs), int(adata.n_vars))

    adata.raw = adata.copy()
    sc.pp.normalize_total(adata, target_sum=target_sum)
    sc.pp.log1p(adata)
    if n_top_genes > 0 and adata.n_vars > n_top_genes:
        sc.pp.highly_variable_genes(adata, n_top_genes=n_top_genes)
        adata = adata[:, adata.var["highly_variable"]].copy()
    sc.pp.scale(adata, max_value=10)
    sc.tl.pca(adata, svd_solver="arpack")
    use_pcs = min(n_pcs, int(adata.obsm["X_pca"].shape[1]))
    sc.pp.neighbors(adata, n_neighbors=n_neighbors, n_pcs=use_pcs)
    sc.tl.umap(adata)

    warnings: list[str] = []
    try:
        sc.tl.leiden(adata, resolution=leiden_resolution, key_added="leiden")
    except Exception as exc:
        warnings.append(f"Leiden clustering skipped: {exc}")

    processed_h5ad = out_dir / "processed.h5ad"
    obs_csv = out_dir / "obs_qc.csv"
    var_csv = out_dir / "var_qc.csv"
    adata.write_h5ad(processed_h5ad)
    adata.obs.to_csv(obs_csv)
    adata.var.to_csv(var_csv)

    payload = summarize_adata(adata, processed_h5ad, "h5ad")
    payload.update(
        {
            "input_path": str(path),
            "input_format": fmt,
            "cells_genes_before": before,
            "cells_genes_after_filter": after_filter,
            "processed_h5ad": str(processed_h5ad),
            "obs_qc_csv": str(obs_csv),
            "var_qc_csv": str(var_csv),
            "warnings": warnings,
        }
    )
    return text_result(payload)


def tool_scanpy_rank_markers(args: dict[str, Any]) -> dict[str, Any]:
    adata, path, fmt = read_adata(str(args.get("path", "")), "h5ad")
    groupby = str(args.get("groupby", "")).strip()
    method = str(args.get("method", "wilcoxon") or "wilcoxon")
    if groupby not in adata.obs:
        raise ValueError(f"obs column not found: {groupby}")

    out_dir = Path(str(args["output_dir"])) if args.get("output_dir") else default_output_dir(path)
    out_dir.mkdir(parents=True, exist_ok=True)
    sc.tl.rank_genes_groups(adata, groupby=groupby, method=method)

    groups = [str(x) for x in adata.obs[groupby].astype("category").cat.categories]
    written: list[str] = []
    for group in groups:
        df = sc.get.rank_genes_groups_df(adata, group=group)
        out_file = out_dir / f"rank_genes_{group}.csv"
        df.to_csv(out_file, index=False)
        written.append(str(out_file))

    ranked_h5ad = out_dir / "ranked_markers.h5ad"
    adata.write_h5ad(ranked_h5ad)
    return text_result(
        {
            "ok": True,
            "path": str(path),
            "format": fmt,
            "groupby": groupby,
            "method": method,
            "ranked_h5ad": str(ranked_h5ad),
            "marker_csv_files": written,
        }
    )


TOOL_IMPL = {
    "scanpy_info": tool_scanpy_info,
    "scanpy_inspect": tool_scanpy_inspect,
    "scanpy_preprocess_cluster": tool_scanpy_preprocess_cluster,
    "scanpy_rank_markers": tool_scanpy_rank_markers,
}


def handle_request(msg: dict[str, Any]) -> dict[str, Any] | None:
    method = msg.get("method")
    msg_id = msg.get("id")

    if method == "notifications/initialized" or (method and method.startswith("notifications/")):
        return None

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        }

    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}

    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}
        impl = TOOL_IMPL.get(name)
        if impl is None:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32601, "message": f"Unknown tool: {name}"},
            }
        if sc is None and name != "scanpy_info":
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": error_result(f"Scanpy import failed: {_SCANPY_IMPORT_ERROR}"),
            }
        try:
            result = impl(arguments)
        except Exception as exc:
            log(f"tool '{name}' failed: {exc}")
            return {"jsonrpc": "2.0", "id": msg_id, "result": error_result(str(exc))}
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}

    if msg_id is not None:
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }
    return None


def main() -> None:
    if sc is None:
        log(f"warning: Scanpy import failed; tool calls will report dependency errors: {_SCANPY_IMPORT_ERROR}")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            response = handle_request(msg)
        except Exception as exc:
            log(f"dispatch error: {exc}")
            msg_id = msg.get("id") if isinstance(msg, dict) else None
            if msg_id is not None:
                emit({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32603, "message": str(exc)}})
            continue
        if response is not None:
            emit(response)


if __name__ == "__main__":
    main()
