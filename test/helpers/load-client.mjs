// 加载真实的 lib/client.js bundle（生产工件本身，而非复制源码）：
// 模拟 window.__ModuleLoader__ 捕获模块定义，再以桩 require 调用 factory。
// 与 dsh-conversation-folding/test/helpers/load-client.mjs 同法：new Function
// 在当前 realm 编译，避免 vm.runInNewContext 的异 realm 对象破坏结构化断言。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const primitivesStub = {
  Button: function Button() { return null; },
  Modal: function Modal() { return null; },
  IconRefreshOutline16: function IconRefreshOutline16() { return null; },
  IconArchiveOutline20: function IconArchiveOutline20() { return null; },
  IconWarningOutline16: function IconWarningOutline16() { return null; },
};

export const reactStub = {
  createElement: function createElement() { return null; },
  Fragment: function Fragment() { return null; },
  useState: function useState(value) { return [value, function set() { }]; },
  useEffect: function useEffect() { },
  useCallback: function useCallback(fn) { return fn; },
  useMemo: function useMemo(fn) { return fn(); },
  useRef: function useRef(value) { return { current: value }; },
  useSyncExternalStore: function useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot(); },
};

export async function loadClient(opts = {}) {
  const source = await readFile(fileURLToPath(new URL('../../lib/client.js', import.meta.url)), 'utf8');
  const definitions = [];
  const sandboxWindow = { __ModuleLoader__: { load(definition) { definitions.push(definition); } } };
  const requireStub = (name) => {
    if (name === 'react') return opts.react ?? reactStub;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return opts.primitives ?? primitivesStub;
    throw new Error(`load-client: unexpected require(${name})`);
  };
  const boot = new Function('window', 'require', `${source}\n;`);
  boot(sandboxWindow, requireStub);
  if (definitions.length !== 1) throw new Error(`load-client: expected 1 module, got ${definitions.length}`);
  return definitions[0].factory(requireStub);
}
