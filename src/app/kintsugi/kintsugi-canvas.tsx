import * as React from "react";

import { useToolcraft } from "@/toolcraft/runtime/react";

import styles from "./kintsugi-canvas.module.css";
import { readKintsugiSettings, readRenderScale } from "./kintsugi-values";
import { KintsugiSceneManager, setActiveKintsugiScene } from "./scene";
import { isKintsugiWebglAvailable } from "./stage";

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
      <canvas aria-label="Kintsugi vessel 3D preview" ref={canvasRef} />
    </div>
  );
}
