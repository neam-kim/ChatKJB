import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**"],
    // 사용량 한도 문구 파싱과 턴 프롬프트의 현재 시각 안내는 로컬 시간대를
    // 사용한다. 개발자 기기나 CI 러너의 시간대에 따라 결과가 달라지지 않도록
    // 테스트 실행 시간대를 고정한다. 런타임 시간대는 TZ 환경변수로 계속 바꿀 수 있다.
    env: { TZ: "Asia/Seoul" }
  }
});
