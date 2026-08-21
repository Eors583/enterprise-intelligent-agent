import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';

const GLOBAL_KEYS = [
  'window',
  'self',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLTextAreaElement',
  'HTMLFormElement',
  'FormData',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

export interface TestDom {
  container: HTMLElement;
  document: Document;
  click: (element: Element) => Promise<void>;
  focus: (element: Element) => Promise<void>;
  change: (
    element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
    value: string,
  ) => Promise<void>;
  submit: (form: HTMLFormElement) => Promise<void>;
  keydown: (element: Element, key: string) => Promise<void>;
  flush: () => Promise<void>;
  cleanup: () => Promise<void>;
}

export async function renderInTestDom(element: ReactNode): Promise<TestDom> {
  const parsed = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.defineProperty(parsed.document, 'oninput', {
    configurable: true,
    writable: true,
    value: null,
  });
  const windowObject = parsed.window as unknown as Record<string, unknown>;
  const documentObject = parsed.document as unknown as Document;
  const previous = new Map<string, PropertyDescriptor | undefined>();

  for (const key of GLOBAL_KEYS) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }

  const eventConstructor = windowObject.Event as typeof Event;
  class TestFormData {
    private readonly values = new Map<string, FormDataEntryValue>();

    constructor(form?: HTMLFormElement) {
      if (!form) return;
      for (const element of form.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >('input[name], select[name], textarea[name]')) {
        const name = element.getAttribute('name');
        if (!name) continue;
        const type = element.getAttribute('type');
        if ((type === 'checkbox' || type === 'radio') && !(element as HTMLInputElement).checked) {
          continue;
        }
        this.values.set(name, element.value);
      }
    }

    get(name: string): FormDataEntryValue | null {
      return this.values.get(name) ?? null;
    }
  }
  const bindings: Readonly<Record<string, unknown>> = {
    window: parsed.window,
    self: parsed.window,
    document: parsed.document,
    navigator: windowObject.navigator ?? { userAgent: 'linkedom' },
    Node: windowObject.Node,
    Element: windowObject.Element,
    HTMLElement: windowObject.HTMLElement,
    HTMLInputElement: windowObject.HTMLInputElement,
    HTMLSelectElement: windowObject.HTMLSelectElement,
    HTMLTextAreaElement: windowObject.HTMLTextAreaElement,
    HTMLFormElement: windowObject.HTMLFormElement,
    FormData: TestFormData,
    Event: eventConstructor,
    KeyboardEvent: windowObject.KeyboardEvent ?? eventConstructor,
    MouseEvent: windowObject.MouseEvent ?? eventConstructor,
    getComputedStyle: windowObject.getComputedStyle ?? (() => ({})),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  };

  for (const [key, value] of Object.entries(bindings)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const container = documentObject.getElementById('root') as HTMLElement | null;
  if (!container) throw new Error('Test DOM root was not created.');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });

  const dispatch = async (target: Element, type: string): Promise<void> => {
    await act(async () => {
      target.dispatchEvent(new eventConstructor(type, { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
  };

  return {
    container,
    document: documentObject,
    click: (target) => dispatch(target, 'click'),
    focus: (target) => dispatch(target, 'focusin'),
    change: async (target, value) => {
      const selectConstructor = bindings.HTMLSelectElement as typeof HTMLSelectElement;
      if (target instanceof selectConstructor) {
        for (const option of target.querySelectorAll('option')) {
          if (option.getAttribute('value') === value) option.setAttribute('selected', '');
          else option.removeAttribute('selected');
        }
        await dispatch(target, 'change');
      } else {
        const previousValue = target.value;
        setNativeValue(target, value);
        (
          target as typeof target & {
            _valueTracker?: { setValue: (trackedValue: string) => void };
          }
        )._valueTracker?.setValue(previousValue);
        await dispatch(target, 'input');
        await dispatch(target, 'change');
      }
    },
    submit: (form) => dispatch(form, 'submit'),
    keydown: async (target, key) => {
      await act(async () => {
        const KeyboardEventConstructor =
          (windowObject.KeyboardEvent as typeof KeyboardEvent | undefined) ?? eventConstructor;
        const event = new KeyboardEventConstructor('keydown', {
          bubbles: true,
          cancelable: true,
          key,
        } as KeyboardEventInit);
        if ((event as KeyboardEvent).key !== key)
          Object.defineProperty(event, 'key', { configurable: true, value: key });
        target.dispatchEvent(event);
        await Promise.resolve();
      });
    },
    flush: async () => {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      restoreGlobals(previous);
    },
  };
}

function restoreGlobals(previous: ReadonlyMap<string, PropertyDescriptor | undefined>): void {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}

function setNativeValue(target: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  let prototype = Object.getPrototypeOf(target) as object | null;
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) {
      descriptor.set.call(target, value);
      return;
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  throw new Error('The test DOM control has no native value setter.');
}
