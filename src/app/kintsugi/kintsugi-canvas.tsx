import * as React from "react";

import { useToolcraft } from "@/toolcraft/runtime/react";

import styles from "./kintsugi-canvas.module.css";
import { DarkThemeLock } from "./dark-theme-lock";
import { readKintsugiSettings, readRenderScale } from "./kintsugi-values";
import {
  computeBottomDockHeight,
  MobileViewportLayout,
  mobileViewportMaxWidthPx,
  type MobileViewportSnapshot,
} from "./mobile-viewport-layout";
import { KintsugiSceneManager, setActiveKintsugiScene } from "./scene";
import { isKintsugiWebglAvailable } from "./stage";

function readMobileViewportSnapshot(): MobileViewportSnapshot {
  if (typeof window === "undefined") {
    return { isMobile: false, viewportHeight: 0, viewportWidth: 0 };
  }

  const viewport = window.visualViewport;

  return {
    isMobile: window.innerWidth <= mobileViewportMaxWidthPx,
    viewportHeight: viewport?.height ?? window.innerHeight,
    viewportWidth: viewport?.width ?? window.innerWidth,
  };
}

export function KintsugiCanvas(): React.JSX.Element {
  const { state } = useToolcraft();
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const managerRef = React.useRef<KintsugiSceneManager | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas || !isKintsugiWebglAvailable()) {
      return;
    }

    const manager = new KintsugiSceneManager(canvas);

    managerRef.current = manager;
    setActiveKintsugiScene(manager);

    return () => {
      setActiveKintsugiScene(null);
      managerRef.current = null;
      manager.dispose();
    };
  }, []);

  const settings = readKintsugiSettings(state);
  const renderScale = readRenderScale(state);
  const canvasWidth = state.canvas.size.width;
  const canvasHeight = state.canvas.size.height;
  const viewportOffsetX = state.canvas.offset.x;
  const viewportOffsetY = state.canvas.offset.y;
  const viewportZoom = state.canvas.zoom;
  const [mobileViewport, setMobileViewport] = React.useState<MobileViewportSnapshot>(
    readMobileViewportSnapshot,
  );

  React.useEffect(() => {
    const updateViewport = (): void => {
      setMobileViewport(readMobileViewportSnapshot());
    };

    const mediaQueryList = window.matchMedia(
      `(max-width: ${mobileViewportMaxWidthPx}px)`,
    );

    mediaQueryList.addEventListener("change", updateViewport);
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.addEventListener("resize", updateViewport);
    updateViewport();

    return () => {
      mediaQueryList.removeEventListener("change", updateViewport);
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.removeEventListener("resize", updateViewport);
    };
  }, []);

  React.useEffect(() => {
    managerRef.current?.applySettings(settings);
    // The settings object is rebuilt every render; diffing happens inside the
    // scene manager, keyed by the primitive values below.
  }, [
    settings.autoRotate,
    settings.background,
    settings.easing,
    settings.glazePreset,
    settings.includeBackground,
    settings.lightAmbientDome,
    settings.lightExposure,
    settings.lightFill,
    settings.lightKey,
    settings.lightSoftbox,
    settings.rotXDeg,
    settings.rotYDeg,
    settings.rotZDeg,
    settings.seamRelief,
    settings.seamWidth,
    settings.resetToken,
  ]);

  React.useEffect(() => {
    managerRef.current?.setViewSize(canvasWidth, canvasHeight, renderScale);
  }, [canvasHeight, canvasWidth, renderScale]);

  React.useEffect(() => {
    managerRef.current?.setViewportLayout({
      bottomInsetPx: mobileViewport.isMobile ? computeBottomDockHeight() : 0,
      isMobile: mobileViewport.isMobile,
      viewportHeight: mobileViewport.viewportHeight,
      viewportWidth: mobileViewport.viewportWidth,
    });
  }, [
    mobileViewport.isMobile,
    mobileViewport.viewportHeight,
    mobileViewport.viewportWidth,
  ]);

  const viewportInteractionSeenRef = React.useRef(false);

  React.useEffect(() => {
    if (!viewportInteractionSeenRef.current) {
      viewportInteractionSeenRef.current = true;
      return;
    }

    managerRef.current?.notifyViewportInteraction();
  }, [viewportOffsetX, viewportOffsetY, viewportZoom]);

  return (
    <div className={styles.host} data-toolcraft-product-output="">
      <DarkThemeLock />
      <MobileViewportLayout />
      <canvas aria-label="Kintsugi vessel 3D preview" ref={canvasRef} />
    </div>
  );
}
