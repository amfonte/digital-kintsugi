import * as React from "react";

import { useToolcraft } from "@/toolcraft/runtime/react";

import { MobileToolbarDock } from "./mobile-toolbar-dock";

export const mobileViewportMaxWidthPx = 767;
const controlsExpandedMaxHeightVh = 75;
const toolbarBottomPx = 10;
const dockGapPx = 8;
const mobileHorizontalInsetPx = 12;
const mobileDefaultCanvasZoom = 50;
const mobileToolbarFallbackHeightPx = 44;

export type MobileViewportSnapshot = {
  isMobile: boolean;
  viewportHeight: number;
  viewportWidth: number;
};

type StyleRestoreEntry = {
  element: HTMLElement;
  keys: string[];
  previous: Record<string, string>;
};

function useMobileViewport(): MobileViewportSnapshot {
  const [snapshot, setSnapshot] = React.useState<MobileViewportSnapshot>(() => ({
    isMobile: false,
    viewportHeight: 0,
    viewportWidth: 0,
  }));

  React.useEffect(() => {
    const mediaQueryList = window.matchMedia(
      `(max-width: ${mobileViewportMaxWidthPx}px)`,
    );

    const updateSnapshot = (): void => {
      const viewport = window.visualViewport;

      setSnapshot({
        isMobile: window.innerWidth <= mobileViewportMaxWidthPx,
        viewportHeight: viewport?.height ?? window.innerHeight,
        viewportWidth: viewport?.width ?? window.innerWidth,
      });
    };

    mediaQueryList.addEventListener("change", updateSnapshot);
    window.visualViewport?.addEventListener("resize", updateSnapshot);
    window.visualViewport?.addEventListener("scroll", updateSnapshot);
    window.addEventListener("resize", updateSnapshot);
    updateSnapshot();

    return () => {
      mediaQueryList.removeEventListener("change", updateSnapshot);
      window.visualViewport?.removeEventListener("resize", updateSnapshot);
      window.visualViewport?.removeEventListener("scroll", updateSnapshot);
      window.removeEventListener("resize", updateSnapshot);
    };
  }, []);

  return snapshot;
}

function captureInlineStyles(
  element: HTMLElement,
  keys: readonly string[],
): StyleRestoreEntry {
  const previous: Record<string, string> = {};

  for (const key of keys) {
    previous[key] = element.style.getPropertyValue(
      key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`),
    );
  }

  return { element, keys: [...keys], previous };
}

function restoreInlineStyles(entry: StyleRestoreEntry): void {
  for (const key of entry.keys) {
    const cssKey = key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
    const value = entry.previous[key];

    if (value) {
      entry.element.style.setProperty(cssKey, value);
    } else {
      entry.element.style.removeProperty(cssKey);
    }
  }
}

function findPanelOuterWrapper(panelType: string): HTMLElement | null {
  const host = document.querySelector(
    `[data-panel-type="${panelType}"][data-slot="toolcraft-runtime-panel-host"]`,
  );

  return host?.parentElement instanceof HTMLElement ? host.parentElement : null;
}

function findRuntimeToolbarWrapper(): HTMLElement | null {
  const surface = document.querySelector('[data-toolcraft-inspect-toolbar="true"]');
  const host = surface?.closest('[data-slot="toolcraft-runtime-panel-host"]');

  return host?.parentElement instanceof HTMLElement ? host.parentElement : null;
}

export function computeBottomDockHeight(): number {
  const mobileToolbar = document.querySelector('[data-kintsugi-mobile-toolbar=""]');
  const controlsPanel = document.querySelector('[data-panel-id="properties"]');
  const toolbarHeight =
    mobileToolbar instanceof HTMLElement
      ? mobileToolbar.getBoundingClientRect().height
      : mobileToolbarFallbackHeightPx;
  const controlsHeight =
    controlsPanel instanceof HTMLElement
      ? controlsPanel.getBoundingClientRect().height
      : 36;

  return toolbarBottomPx + toolbarHeight + dockGapPx + controlsHeight;
}

function ensureMobileControlsCollapsed(): void {
  const controlsPanel = document.querySelector('[data-panel-id="properties"]');

  if (!(controlsPanel instanceof HTMLElement)) {
    return;
  }

  if (!controlsPanel.querySelector('[data-slot="toolcraft-panel-content"]')) {
    return;
  }

  const collapseButton = controlsPanel.querySelector(
    'button[aria-label="Collapse controls"]',
  );

  if (collapseButton instanceof HTMLButtonElement) {
    collapseButton.click();
  }
}

function setRuntimeToolbarHidden(hidden: boolean): void {
  const wrapper = findRuntimeToolbarWrapper();

  if (!(wrapper instanceof HTMLElement)) {
    return;
  }

  if (hidden) {
    wrapper.style.setProperty("display", "none", "important");
    return;
  }

  wrapper.style.removeProperty("display");
}

function applyMobilePanelLayout(
  restoreEntries: StyleRestoreEntry[],
  options: { collapseControls: boolean },
): void {
  const appRoot = document.querySelector('[data-slot="toolcraft-runtime-app"]');
  const controlsWrapper = findPanelOuterWrapper("controls");
  const runtimeToolbarWrapper = findRuntimeToolbarWrapper();
  const controlsPanel = document.querySelector('[data-panel-id="properties"]');
  const controlsHost = document.querySelector(
    '[data-panel-type="controls"][data-slot="toolcraft-runtime-panel-host"]',
  );
  const mobileToolbar = document.querySelector('[data-kintsugi-mobile-toolbar=""]');

  if (!(appRoot instanceof HTMLElement)) {
    return;
  }

  if (restoreEntries.length === 0) {
    restoreEntries.push(
      captureInlineStyles(appRoot, ["minWidth"]),
      ...(controlsWrapper
        ? [captureInlineStyles(controlsWrapper, [
            "position",
            "bottom",
            "left",
            "right",
            "top",
            "transform",
            "width",
            "zIndex",
          ])]
        : []),
      ...(runtimeToolbarWrapper
        ? [captureInlineStyles(runtimeToolbarWrapper, ["display"])]
        : []),
      ...(controlsPanel instanceof HTMLElement
        ? [
            captureInlineStyles(controlsPanel, [
              "width",
              "maxWidth",
              "maxHeight",
            ]),
          ]
        : []),
      ...(controlsHost instanceof HTMLElement
        ? [captureInlineStyles(controlsHost, ["transform", "touchAction"])]
        : []),
    );
  }

  elementSetStyleProperty(appRoot, "min-width", "0");
  appRoot.dataset.kintsugiMobileLayout = "true";
  setRuntimeToolbarHidden(true);

  const toolbarHeight =
    mobileToolbar instanceof HTMLElement
      ? mobileToolbar.getBoundingClientRect().height
      : mobileToolbarFallbackHeightPx;
  const controlsBottom = toolbarBottomPx + toolbarHeight + dockGapPx;

  if (controlsWrapper instanceof HTMLElement) {
    Object.assign(controlsWrapper.style, {
      bottom: `${controlsBottom}px`,
      left: `${mobileHorizontalInsetPx}px`,
      position: "fixed",
      right: `${mobileHorizontalInsetPx}px`,
      top: "auto",
      transform: "none",
      width: "auto",
      zIndex: "70",
    });
  }

  if (controlsHost instanceof HTMLElement) {
    controlsHost.style.setProperty("transform", "translate3d(0px, 0px, 0px)", "important");
    elementSetStyleProperty(controlsHost, "touch-action", "manipulation");
  }

  if (controlsPanel instanceof HTMLElement) {
    Object.assign(controlsPanel.style, {
      maxHeight: `${controlsExpandedMaxHeightVh}dvh`,
      maxWidth: "100%",
      width: "100%",
    });
  }

  if (options.collapseControls) {
    ensureMobileControlsCollapsed();
  }
}

function elementSetStyleProperty(
  element: HTMLElement,
  property: string,
  value: string,
): void {
  element.style.setProperty(property, value);
}

function clearMobilePanelLayout(restoreEntries: StyleRestoreEntry[]): void {
  const appRoot = document.querySelector('[data-slot="toolcraft-runtime-app"]');

  if (appRoot instanceof HTMLElement) {
    delete appRoot.dataset.kintsugiMobileLayout;
  }

  setRuntimeToolbarHidden(false);

  for (const entry of restoreEntries.splice(0, restoreEntries.length)) {
    restoreInlineStyles(entry);
  }
}

export function MobileViewportLayout(): React.JSX.Element | null {
  const { dispatch } = useToolcraft();
  const { isMobile, viewportHeight, viewportWidth } = useMobileViewport();
  const restoreEntriesRef = React.useRef<StyleRestoreEntry[]>([]);
  const dragBlockersRef = React.useRef<
    Array<{ element: Element; listener: (event: Event) => void }>
  >([]);
  const wasMobileRef = React.useRef(false);
  const layoutFrameRef = React.useRef<number | null>(null);

  const resetMobilePanelOffsets = React.useCallback((): void => {
    dispatch({ panelId: "controls", type: "panels.resetOffset" });
    dispatch({ panelId: "toolbar", type: "panels.resetOffset" });
  }, [dispatch]);

  const applyMobileCanvasViewport = React.useCallback((): void => {
    dispatch({
      offset: { x: 0, y: 0 },
      type: "canvas.setViewport",
      zoom: mobileDefaultCanvasZoom,
    });
    resetMobilePanelOffsets();
  }, [dispatch, resetMobilePanelOffsets]);

  React.useLayoutEffect(() => {
    if (layoutFrameRef.current !== null) {
      window.cancelAnimationFrame(layoutFrameRef.current);
    }

    layoutFrameRef.current = window.requestAnimationFrame(() => {
      layoutFrameRef.current = null;
      const enteringMobile = isMobile && !wasMobileRef.current;

      if (isMobile) {
        resetMobilePanelOffsets();
        applyMobilePanelLayout(restoreEntriesRef.current, {
          collapseControls: enteringMobile,
        });

        if (enteringMobile) {
          applyMobileCanvasViewport();
        }
      } else if (wasMobileRef.current) {
        clearMobilePanelLayout(restoreEntriesRef.current);
        dispatch({ type: "canvas.center" });
        dispatch({ type: "canvas.zoomReset" });
      }

      wasMobileRef.current = isMobile;
    });

    return () => {
      if (layoutFrameRef.current !== null) {
        window.cancelAnimationFrame(layoutFrameRef.current);
        layoutFrameRef.current = null;
      }
    };
  }, [
    applyMobileCanvasViewport,
    dispatch,
    isMobile,
    resetMobilePanelOffsets,
    viewportHeight,
    viewportWidth,
  ]);

  React.useLayoutEffect(() => {
    if (!isMobile) {
      return undefined;
    }

    const updateControlsPosition = (): void => {
      applyMobilePanelLayout(restoreEntriesRef.current, {
        collapseControls: false,
      });
    };

    updateControlsPosition();
    const observer = new ResizeObserver(updateControlsPosition);
    const mobileToolbar = document.querySelector('[data-kintsugi-mobile-toolbar=""]');

    if (mobileToolbar instanceof HTMLElement) {
      observer.observe(mobileToolbar);
    }

    return () => {
      observer.disconnect();
    };
  }, [isMobile, viewportWidth]);

  React.useEffect(() => {
    for (const blocker of dragBlockersRef.current) {
      blocker.element.removeEventListener("pointerdown", blocker.listener, true);
    }

    dragBlockersRef.current = [];

    if (!isMobile) {
      return undefined;
    }

    const blockPanelDrag = (event: Event): void => {
      const target = event.target;

      if (target instanceof Element && target.closest("button")) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const controlsHandle = document.querySelector(
      '[data-panel-type="controls"] [data-panel-drag-handle]',
    );

    if (controlsHandle) {
      controlsHandle.addEventListener("pointerdown", blockPanelDrag, true);
      dragBlockersRef.current.push({
        element: controlsHandle,
        listener: blockPanelDrag,
      });
    }

    return () => {
      for (const blocker of dragBlockersRef.current) {
        blocker.element.removeEventListener(
          "pointerdown",
          blocker.listener,
          true,
        );
      }

      dragBlockersRef.current = [];
    };
  }, [isMobile]);

  React.useEffect(() => {
    return () => {
      clearMobilePanelLayout(restoreEntriesRef.current);
    };
  }, []);

  if (!isMobile) {
    return null;
  }

  return <MobileToolbarDock mounted={isMobile} />;
}
