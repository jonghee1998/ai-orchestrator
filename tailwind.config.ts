import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 다크모드 기본 팔레트 (앱 전역 토큰)
        bg: {
          DEFAULT: "#0a0b0e",
          raised: "#13151a",
          card: "#181b22",
        },
        border: {
          DEFAULT: "#262a33",
          subtle: "#1e222a",
        },
        text: {
          DEFAULT: "#e6e8ec",
          muted: "#9aa0ab",
          faint: "#646b78",
        },
        accent: {
          DEFAULT: "#5b8def",
          dim: "#2b3a5c",
        },
        // 상태 색상
        ok: "#3fb950",
        warn: "#d29922",
        danger: "#f85149",
        unknown: "#6e7681",
      },
      maxWidth: {
        app: "520px",
      },
    },
  },
  plugins: [],
};

export default config;
