Web typechecking uses the existing native TypeScript compiler in both npm and
the landing verifier. The JavaScript compiler remains an explicit all-scope
fallback; scratch-copy checks cover strict and JSX diagnostic parity.
