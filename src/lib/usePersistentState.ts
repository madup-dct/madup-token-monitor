import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

function resolve<T>(action: SetStateAction<T>, previous: T): T {
  return typeof action === "function" ? (action as (value: T) => T)(previous) : action;
}

/// useState 드롭인 교체 — 값을 localStorage 에 영속한다.
/// 컴포넌트가 언마운트(라우트 이동)돼도, 앱을 재시작해도 마지막 선택값이 유지된다.
/// 뷰 토글(기간/단위/지표/차트·리스트 등) 처럼 "사용자 선택"을 보존할 때 사용.
export function usePersistentState<T>(
  key: string,
  initial: T,
  isValid?: (value: unknown) => value is T
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = globalThis.localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed: unknown = JSON.parse(raw);
      return !isValid || isValid(parsed) ? (parsed as T) : initial;
    } catch (error) {
      if (error instanceof globalThis.DOMException || error instanceof SyntaxError) return initial;
      throw error;
    }
  });
  const valueRef = useRef(value);
  useLayoutEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => {
    try {
      globalThis.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      if (error instanceof globalThis.DOMException || error instanceof TypeError) return;
      throw error;
    }
  }, [key, value]);

  const setPersistentValue = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      const next = resolve(action, valueRef.current);
      valueRef.current = next;
      try {
        globalThis.localStorage.setItem(key, JSON.stringify(next));
      } catch (error) {
        if (!(error instanceof globalThis.DOMException || error instanceof TypeError)) throw error;
      }
      setValue(next);
    },
    [key]
  );

  return [value, setPersistentValue];
}
