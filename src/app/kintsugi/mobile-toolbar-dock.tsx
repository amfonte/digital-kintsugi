import * as React from "react";
import { createPortal } from "react-dom";
import { TargetIcon } from "@phosphor-icons/react";
import { Redo2, Undo2, ZoomIn, ZoomOut } from "lucide-react";

import { useToolcraft } from "@/toolcraft/runtime/react";

import styles from "./mobile-toolbar-dock.module.css";

type MobileToolbarDockProps = {
  mounted: boolean;
};

function MobileToolbarButton({
  children,
  disabled = false,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      className={styles.button}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export function MobileToolbarDock({
  mounted,
}: MobileToolbarDockProps): React.JSX.Element | null {
  const { dispatch, state } = useToolcraft();
  const [portalTarget, setPortalTarget] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  if (!mounted || !portalTarget) {
    return null;
  }

  const historyEnabled = state.schema.toolbar.history;
  const radarEnabled = state.schema.toolbar.radar;
  const zoomEnabled = state.schema.toolbar.zoom;
  const canUndo = state.history.undo.length > 0;
  const canRedo = state.history.redo.length > 0;

  return createPortal(
    <div className={styles.dock} data-kintsugi-mobile-toolbar="">
      <div className={styles.surface}>
        {historyEnabled ? (
          <>
            <MobileToolbarButton
              disabled={!canUndo}
              label="Undo"
              onClick={() => dispatch({ type: "history.undo" })}
            >
              <Undo2 aria-hidden="true" className={styles.icon} />
            </MobileToolbarButton>
            <MobileToolbarButton
              disabled={!canRedo}
              label="Redo"
              onClick={() => dispatch({ type: "history.redo" })}
            >
              <Redo2 aria-hidden="true" className={styles.icon} />
            </MobileToolbarButton>
          </>
        ) : null}
        {zoomEnabled ? (
          <>
            <MobileToolbarButton
              label="Zoom out"
              onClick={() => dispatch({ type: "canvas.zoomOut" })}
            >
              <ZoomOut aria-hidden="true" className={styles.icon} />
            </MobileToolbarButton>
            <span
              className={styles.zoomLabel}
              onDoubleClick={(event) => {
                event.preventDefault();
                dispatch({ type: "canvas.zoomReset" });
              }}
            >
              {state.canvas.zoom}%
            </span>
            <MobileToolbarButton
              label="Zoom in"
              onClick={() => dispatch({ type: "canvas.zoomIn" })}
            >
              <ZoomIn aria-hidden="true" className={styles.icon} />
            </MobileToolbarButton>
          </>
        ) : null}
        {radarEnabled ? (
          <MobileToolbarButton
            label="Center canvas"
            onClick={() => dispatch({ type: "canvas.center" })}
          >
            <TargetIcon aria-hidden="true" className={styles.icon} />
          </MobileToolbarButton>
        ) : null}
      </div>
    </div>,
    portalTarget,
  );
}
