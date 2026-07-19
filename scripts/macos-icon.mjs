// ChatKJB의 macOS 앱 아이콘 생성기.
//
// ChatKJB Terminal 앱과 백그라운드 데몬(ChatKJB.app)이 같은 로고를 쓰도록
// native/macos/jb-logo.svg 하나에서 AppIcon.icns를 만든다. 두 빌드가 서로
// 다른 아이콘으로 갈라지지 않게 이 모듈만 사용한다.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

const ICON_REPRESENTATIONS = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024]
];

export function appIconSourcePath(projectDir) {
  return join(projectDir, "native", "macos", "jb-logo.svg");
}

// buildDir에 중간 산출물을 만들고 outputIcnsPath에 최종 .icns를 남긴다.
export function buildAppIcon({ projectDir, buildDir, outputIcnsPath }) {
  const iconSource = appIconSourcePath(projectDir);
  if (!existsSync(iconSource)) {
    throw new Error(`앱 아이콘 원본을 찾지 못했습니다: ${iconSource}`);
  }

  mkdirSync(buildDir, { recursive: true });
  execFileSync("/usr/bin/qlmanage", [
    "-t",
    "-s", "1024",
    "-o", buildDir,
    iconSource
  ], { cwd: projectDir, stdio: "ignore" });

  const renderedIcon = join(buildDir, `${basename(iconSource)}.png`);
  if (!existsSync(renderedIcon)) {
    throw new Error(`아이콘 렌더링에 실패했습니다: ${renderedIcon}`);
  }

  const iconsetDir = join(buildDir, "AppIcon.iconset");
  mkdirSync(iconsetDir, { recursive: true });
  for (const [name, size] of ICON_REPRESENTATIONS) {
    execFileSync("/usr/bin/sips", [
      "-z", String(size), String(size),
      renderedIcon,
      "--out", join(iconsetDir, name)
    ], { cwd: projectDir, stdio: "ignore" });
  }

  execFileSync("/usr/bin/iconutil", [
    "-c", "icns",
    iconsetDir,
    "-o", outputIcnsPath
  ], { cwd: projectDir, stdio: "ignore" });

  return outputIcnsPath;
}
