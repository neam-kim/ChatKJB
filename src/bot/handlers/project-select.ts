import { Bot } from "grammy";
import { join, resolve } from "node:path";
import { safeErrorMessage } from "../../telegram-transport.js";
import type { BotDeps } from "../deps.js";
import type { FolderBrowserState } from "../drive-browser.js";
import {
  driveListKeyboard,
  driveListText
} from "../keyboards.js";
import { pendingStartKey } from "../pending-keys.js";

export function registerProjectSelectHandlers(bot: Bot, deps: BotDeps): void {
  const {
    config,
    store,
    folderBrowsers,
    pendingFieldsForDefaults,
    openPendingStartTopic,
    showFolderBrowser,
    projectFromSelectedFolder,
    openPendingReserveTopic
  } = deps;

  bot.callbackQuery(/^newp:/, async (ctx) => {
    const projectIndex = Number.parseInt(ctx.callbackQuery.data.slice("newp:".length), 10);
    const project = Number.isInteger(projectIndex)
      ? config.projects[projectIndex]
      : undefined;
    if (!project) {
      await ctx.answerCallbackQuery({ text: "프로젝트를 찾을 수 없습니다." });
      return;
    }
    const defaults = store.getSessionDefaults();
    await openPendingStartTopic(ctx.from.id, project, defaults, pendingFieldsForDefaults(defaults));
    await ctx.answerCallbackQuery({ text: `${project.name} 선택` });
    await ctx.reply(`${project.name} 작업 토픽을 열었습니다.`);
  });

  bot.callbackQuery(/^newfs:/, async (ctx) => {
    const key = pendingStartKey(ctx.from.id, ctx.callbackQuery.message?.message_thread_id);
    const state = folderBrowsers.get(key);
    if (!state) {
      await ctx.answerCallbackQuery({ text: "폴더 선택 상태가 만료되었습니다.", show_alert: true });
      return;
    }
    const action = ctx.callbackQuery.data.slice("newfs:".length);
    // 드라이브 선택 액션
    if (action.startsWith("d:")) {
      const index = Number.parseInt(action.slice("d:".length), 10);
      const drive = Number.isInteger(index) ? state.drives?.[index] : undefined;
      if (!drive) {
        await ctx.answerCallbackQuery({ text: "드라이브를 찾을 수 없습니다.", show_alert: true });
        return;
      }
      try {
        await showFolderBrowser(key, drive.path, state.drives, drive.path, drive.label, "newfs", (text, keyboard) =>
          ctx.editMessageText(text, { reply_markup: keyboard })
        );
        await ctx.answerCallbackQuery({ text: drive.label });
      } catch (error) {
        await ctx.answerCallbackQuery({ text: "드라이브를 읽지 못했습니다.", show_alert: true });
        await ctx.reply(`드라이브를 읽지 못했습니다.\n${safeErrorMessage(error)}`);
      }
      return;
    }
    if (action === "s") {
      const defaults = store.getSessionDefaults();
      const project = projectFromSelectedFolder(state.currentPath);
      await openPendingStartTopic(ctx.from.id, project, defaults, pendingFieldsForDefaults(defaults));
      folderBrowsers.delete(key);
      await ctx.answerCallbackQuery({ text: `${project.name} 선택` });
      await ctx.editMessageText(`${project.name} 작업 토픽을 열었습니다.`);
      return;
    }
    if (action === "b") {
      try {
        if (state.drives !== null) {
          const isDriveRoot = state.drives.some((d) => d.path === state.currentPath);
          if (isDriveRoot) {
            const dummyState: FolderBrowserState = {
              currentPath: "",
              directories: [],
              drives: state.drives,
              rootPath: "",
              driveLabel: ""
            };
            folderBrowsers.set(key, dummyState);
            await ctx.editMessageText(driveListText(), { reply_markup: driveListKeyboard(state.drives, "newfs") });
            await ctx.answerCallbackQuery({ text: "드라이브 목록" });
            return;
          }
        }
        if (state.currentPath === state.rootPath) {
          await ctx.answerCallbackQuery({ text: "상위 폴더가 없습니다." });
          return;
        }
        await showFolderBrowser(key, resolve(state.currentPath, ".."), state.drives, state.rootPath, state.driveLabel, "newfs", (text, keyboard) =>
          ctx.editMessageText(text, { reply_markup: keyboard })
        );
        await ctx.answerCallbackQuery({ text: "뒤로" });
      } catch (error) {
        await ctx.answerCallbackQuery({ text: "상위 폴더를 읽지 못했습니다.", show_alert: true });
        await ctx.reply(`상위 폴더를 읽지 못했습니다.\n${safeErrorMessage(error)}`);
      }
      return;
    }
    if (action.startsWith("o:")) {
      const index = Number.parseInt(action.slice("o:".length), 10);
      const directory = Number.isInteger(index) ? state.directories[index] : undefined;
      if (!directory) {
        await ctx.answerCallbackQuery({ text: "폴더를 찾을 수 없습니다.", show_alert: true });
        return;
      }
      try {
        await showFolderBrowser(key, join(state.currentPath, directory), state.drives, state.rootPath, state.driveLabel, "newfs", (text, keyboard) =>
          ctx.editMessageText(text, { reply_markup: keyboard })
        );
        await ctx.answerCallbackQuery({ text: directory });
      } catch (error) {
        await ctx.answerCallbackQuery({ text: "폴더를 읽지 못했습니다.", show_alert: true });
        await ctx.reply(`폴더를 읽지 못했습니다.\n${safeErrorMessage(error)}`);
      }
      return;
    }
    await ctx.answerCallbackQuery({ text: "지원하지 않는 폴더 동작입니다.", show_alert: true });
  });

  bot.callbackQuery(/^resfs:/, async (ctx) => {
    const key = pendingStartKey(ctx.from.id, ctx.callbackQuery.message?.message_thread_id);
    const state = folderBrowsers.get(key);
    if (!state) {
      await ctx.answerCallbackQuery({ text: "폴더 선택 상태가 만료되었습니다.", show_alert: true });
      return;
    }
    const action = ctx.callbackQuery.data.slice("resfs:".length);
    // 드라이브 선택 액션
    if (action.startsWith("d:")) {
      const index = Number.parseInt(action.slice("d:".length), 10);
      const drive = Number.isInteger(index) ? state.drives?.[index] : undefined;
      if (!drive) {
        await ctx.answerCallbackQuery({ text: "드라이브를 찾을 수 없습니다.", show_alert: true });
        return;
      }
      try {
        await showFolderBrowser(key, drive.path, state.drives, drive.path, drive.label, "resfs", (text, keyboard) =>
          ctx.editMessageText(text, { reply_markup: keyboard })
        );
        await ctx.answerCallbackQuery({ text: drive.label });
      } catch (error) {
        await ctx.answerCallbackQuery({ text: "드라이브를 읽지 못했습니다.", show_alert: true });
        await ctx.reply(`드라이브를 읽지 못했습니다.\n${safeErrorMessage(error)}`);
      }
      return;
    }
    if (action === "s") {
      const project = projectFromSelectedFolder(state.currentPath);
      await openPendingReserveTopic(ctx.from.id, project, store.getSessionDefaults());
      folderBrowsers.delete(key);
      await ctx.answerCallbackQuery({ text: `${project.name} 예약` });
      await ctx.editMessageText(`${project.name} 예약 토픽을 열었습니다.`);
      return;
    }
    if (action === "b") {
      try {
        if (state.drives !== null) {
          const isDriveRoot = state.drives.some((d) => d.path === state.currentPath);
          if (isDriveRoot) {
            const dummyState: FolderBrowserState = {
              currentPath: "",
              directories: [],
              drives: state.drives,
              rootPath: "",
              driveLabel: ""
            };
            folderBrowsers.set(key, dummyState);
            await ctx.editMessageText(driveListText(), { reply_markup: driveListKeyboard(state.drives, "resfs") });
            await ctx.answerCallbackQuery({ text: "드라이브 목록" });
            return;
          }
        }
        if (state.currentPath === state.rootPath) {
          await ctx.answerCallbackQuery({ text: "상위 폴더가 없습니다." });
          return;
        }
        await showFolderBrowser(key, resolve(state.currentPath, ".."), state.drives, state.rootPath, state.driveLabel, "resfs", (text, keyboard) =>
          ctx.editMessageText(text, { reply_markup: keyboard })
        );
        await ctx.answerCallbackQuery({ text: "뒤로" });
      } catch (error) {
        await ctx.answerCallbackQuery({ text: "상위 폴더를 읽지 못했습니다.", show_alert: true });
        await ctx.reply(`상위 폴더를 읽지 못했습니다.\n${safeErrorMessage(error)}`);
      }
      return;
    }
    if (action.startsWith("o:")) {
      const index = Number.parseInt(action.slice("o:".length), 10);
      const directory = Number.isInteger(index) ? state.directories[index] : undefined;
      if (!directory) {
        await ctx.answerCallbackQuery({ text: "폴더를 찾을 수 없습니다.", show_alert: true });
        return;
      }
      try {
        await showFolderBrowser(key, join(state.currentPath, directory), state.drives, state.rootPath, state.driveLabel, "resfs", (text, keyboard) =>
          ctx.editMessageText(text, { reply_markup: keyboard })
        );
        await ctx.answerCallbackQuery({ text: directory });
      } catch (error) {
        await ctx.answerCallbackQuery({ text: "폴더를 읽지 못했습니다.", show_alert: true });
        await ctx.reply(`폴더를 읽지 못했습니다.\n${safeErrorMessage(error)}`);
      }
      return;
    }
    await ctx.answerCallbackQuery({ text: "지원하지 않는 폴더 동작입니다.", show_alert: true });
  });

  bot.callbackQuery(/^resp:/, async (ctx) => {
    const projectIndex = Number.parseInt(ctx.callbackQuery.data.slice("resp:".length), 10);
    const project = Number.isInteger(projectIndex)
      ? config.projects[projectIndex]
      : undefined;
    if (!project) {
      await ctx.answerCallbackQuery({ text: "프로젝트를 찾을 수 없습니다." });
      return;
    }
    await openPendingReserveTopic(ctx.from.id, project, store.getSessionDefaults());
    await ctx.answerCallbackQuery({ text: `${project.name} 예약` });
    await ctx.reply(`${project.name} 예약 토픽을 열었습니다.`);
  });
}
