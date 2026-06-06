import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/// useState 드롭인 교체 — 값을 localStorage 에 영속한다.
/// 컴포넌트가 언마운트(라우트 이동)돼도, 앱을 재시작해도 마지막 선택값이 유지된다.
/// 뷰 토글(기간/단위/지표/차트·리스트 등) 처럼 "사용자 선택"을 보존할 때 사용.
export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      setValue((prev) => {
        const next =
          typeof action === "function"
            ? (action as (p: T) => T)(prev)
            : action;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* localStorage 불가 환경 — 메모리 state 로만 동작 */
        }
        return next;
      });
    },
    [key],
  );

  return [value, set];
}
