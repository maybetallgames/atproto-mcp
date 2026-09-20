import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

export default {
  input: "src/index.ts",
  output: {
    file: "dist/index.js",
    format: "es",
    sourcemap: false,
  },
  plugins: [
    nodeResolve({ exportConditions: ["worker", "browser", "import", "default"] }),
    typescript({ target: "ES2022", module: "ESNext" }),
  ],
};

