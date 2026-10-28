import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
export default defineConfig({
  plugins: [tailwindcss()],
  publicDir: false,
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    lib: {
      entry: "extension/src/style-entry.ts",
      formats: ["es"],
      fileName: "styles",
    },
    cssCodeSplit: false,
    rollupOptions: { output: { assetFileNames: "assets/[name][extname]" } },
  },
});
