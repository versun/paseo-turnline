import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const REACT_NATIVE_STUB = `
export const StyleSheet = { hairlineWidth: 0.5, create: (s) => s };
export const View = "View";
export const Text = "Text";
export const Pressable = "Pressable";
export const Easing = { out: (f) => f, in: (f) => f, ease: (t) => t };
export const Animated = {
  Value: class { constructor(v) { this.v = v; } setValue(v) { this.v = v; } interpolate() { return 0; } },
  View: "Animated.View",
  loop: () => ({ start() {}, stop() {} }),
  sequence: () => ({}),
  timing: () => ({}),
};
`;

const PASEO_UI_STUB = `
export const Icon = "Icon";
export const Markdown = "Markdown";
export const FlatList = "FlatList";
export const ScrollView = "ScrollView";
export const TextInput = "TextInput";
export const Loading = "Loading";
export const copyText = async () => {};
export const useToast = () => ({ show() {}, error() {} });
`;

const VIRTUAL_MODULES = new Map([
  ["virtual:react-native", REACT_NATIVE_STUB],
  ["virtual:@getpaseo/plugin/client/ui", PASEO_UI_STUB],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "react-native") {
      return { url: "virtual:react-native", shortCircuit: true };
    }
    if (specifier === "@getpaseo/plugin/client/ui") {
      return { url: "virtual:@getpaseo/plugin/client/ui", shortCircuit: true };
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:")
    ) {
      const base = new URL(specifier, context.parentURL);
      const basePath = fileURLToPath(base);
      for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const candidate = `${basePath}${ext}`;
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },

  load(url, context, nextLoad) {
    const virtualSource = VIRTUAL_MODULES.get(url);
    if (virtualSource !== undefined) {
      return { format: "module", source: virtualSource, shortCircuit: true };
    }
    if (url.startsWith("file:") && (url.endsWith(".ts") || url.endsWith(".tsx"))) {
      const filePath = fileURLToPath(url);
      const raw = readFileSync(filePath, "utf8");
      const { outputText } = ts.transpileModule(raw, {
        fileName: filePath,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
        },
      });
      return { format: "module", source: outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
