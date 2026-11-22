import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 밝은 테마 팔레트 (앱 전역 토큰)
        bg: {
          DEFAULT: "#F6F7F9",
          raised: "#F6F7F9",
          card: "#FFFFFF",
        },
        border: {
          DEFAULT: "#ECEEF1",
          subtle: "#F1F3F5",
        },
        text: {
          DEFAULT: "#111418",
          muted: "#5F6773",
          faint: "#7A828E",
        },
        accent: {
          DEFAULT: "#2563D9",
          dim: "#EEF3FD",
        },
        // 상태 색상
        ok: "#17703C",
        warn: "#8A5A00",
        danger: "#C5221F",
        unknown: "#7A828E",
      },
      maxWidth: {
        app: "520px",
      },
    },
  },
  plugins: [],
};

export default config;
