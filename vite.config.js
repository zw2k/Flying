import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths let the same build work on GitHub Pages project
  // sites (https://username.github.io/repository/) without hard-coding a
  // repository name.
  base: "./",
});
