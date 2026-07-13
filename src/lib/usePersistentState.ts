import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

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
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed: unknown = JSON.parse(raw);
      return !isValid || isValid(parsed) ? (parsed as T) : initial;
    } catch (error) {
      if (error instanceof DOMException || error instanceof SyntaxError) return initial;
      throw error;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      if (error instanceof DOMException || error instanceof TypeError) return;
      throw error;
    }
  }, [key, value]);

  return [value, setValue];
}
