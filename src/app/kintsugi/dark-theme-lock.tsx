import * as React from "react";

import { useToolcraftTheme } from "@/toolcraft/runtime/react";

export function DarkThemeLock(): null {
  const { setThemePreference } = useToolcraftTheme();

  React.useEffect(() => {
    setThemePreference("dark");
  }, [setThemePreference]);

  return null;
}
