import { useCallback, useEffect, useMemo, useState } from 'react';
import { EastNorth } from './Coordinates';
import type { PyramidTileDebugRecord } from './PyramidTileTree';
import type { PyramidInspectionOptions } from './TileLoaderUK';
import { getTerrainRenderer } from '../TerrainContext';
import './PyramidInspectionPanel.css';

export type PyramidInspectionPanelProps = {
  coord: EastNorth;
  active: boolean;
  inspection: PyramidInspectionOptions;
  onInspectionChange: (patch: Partial<PyramidInspectionOptions>) => void;
};

function sortTiles(tiles: readonly PyramidTileDebugRecord[]): PyramidTileDebugRecord[] {
  return [...tiles].sort((a, b) => {
    if (a.inFrustum !== b.inFrustum) return a.inFrustum ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}

export function PyramidInspectionPanel({
  coord,
  active,
  inspection,
  onInspectionChange,
}: PyramidInspectionPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [snapshotTiles, setSnapshotTiles] = useState<readonly PyramidTileDebugRecord[]>([]);
  const [pyramidMeta, setPyramidMeta] = useState<{
    lastLevel: number | null;
    lastLevelViewportMetres: number;
    activeTileCount: number;
    duplicateCount: number;
  } | null>(null);

  const enabled = !!inspection.enabled;
  const showBounds = inspection.showBounds ?? true;
  const showLabels = inspection.showLabels ?? false;
  const selectedKey = inspection.selectedKey ?? null;

  useEffect(() => {
    if (!active || !enabled) {
      setSnapshotTiles([]);
      setPyramidMeta(null);
      return;
    }
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const renderer = getTerrainRenderer(coord);
      const pyramid = renderer.getTerrainDebugSnapshot().pyramid;
      if (pyramid) {
        setSnapshotTiles(pyramid.tiles);
        setPyramidMeta({
          lastLevel: pyramid.lastLevel,
          lastLevelViewportMetres: pyramid.lastLevelViewportMetres,
          activeTileCount: pyramid.activeTileCount,
          duplicateCount: pyramid.duplicatePayloadUrls.length,
        });
      }
    };
    tick();
    const id = window.setInterval(tick, 400);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, coord, enabled]);

  const selectedTile = useMemo(
    () => snapshotTiles.find((tile) => tile.key === selectedKey),
    [selectedKey, snapshotTiles],
  );

  const sortedTiles = useMemo(() => sortTiles(snapshotTiles), [snapshotTiles]);

  const selectTile = useCallback(
    (key: string) => {
      onInspectionChange({ selectedKey: key });
    },
    [onInspectionChange],
  );

  const refetchSelected = useCallback(() => {
    if (!selectedKey) return;
    getTerrainRenderer(coord).refetchPyramidTile(selectedKey);
  }, [coord, selectedKey]);

  const previewSelectedTexture = useCallback(() => {
    if (!selectedKey) return;
    getTerrainRenderer(coord).previewPyramidTileTexture(selectedKey);
  }, [coord, selectedKey]);

  if (!active) return null;

  return (
    <aside className="PyramidInspectionPanel" aria-label="Pyramid tile inspection">
      <header className="PyramidInspectionPanel-header">
        <button
          type="button"
          className="PyramidInspectionPanel-headerButton"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <h2 className="PyramidInspectionPanel-title">Tile inspection</h2>
          <span className="PyramidInspectionPanel-caret" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
        </button>
        <span className="PyramidInspectionPanel-meta">
          {enabled ? `${pyramidMeta?.activeTileCount ?? 0} tiles` : 'off'}
        </span>
      </header>

      {!collapsed && (
        <div className="PyramidInspectionPanel-body">
          <label className="PyramidInspectionPanel-check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) =>
                onInspectionChange({
                  enabled: event.target.checked,
                  selectedKey: event.target.checked ? selectedKey : null,
                })
              }
            />
            Inspection mode
          </label>

          {enabled && (
            <>
              <div className="PyramidInspectionPanel-row">
                <label className="PyramidInspectionPanel-check">
                  <input
                    type="checkbox"
                    checked={showBounds}
                    onChange={(event) => onInspectionChange({ showBounds: event.target.checked })}
                  />
                  Wireframe bounds
                </label>
                <label className="PyramidInspectionPanel-check">
                  <input
                    type="checkbox"
                    checked={showLabels}
                    onChange={(event) => onInspectionChange({ showLabels: event.target.checked })}
                  />
                  Scene labels
                </label>
              </div>

              <p className="PyramidInspectionPanel-hint">
                Shift+click a tile to select it (uses invisible chunk bounds, not terrain mesh).
                Wireframes are optional; selected tile is yellow when shown.
              </p>

              {pyramidMeta && (
                <dl className="PyramidInspectionPanel-dl">
                  <div>
                    <dt>LOD level</dt>
                    <dd>
                      {pyramidMeta.lastLevel ?? '—'} ({Math.round(pyramidMeta.lastLevelViewportMetres)} m viewport)
                    </dd>
                  </div>
                  {pyramidMeta.duplicateCount > 0 && (
                    <div>
                      <dt>Duplicates</dt>
                      <dd>{pyramidMeta.duplicateCount} shared payload URLs</dd>
                    </div>
                  )}
                </dl>
              )}

              {pyramidMeta && pyramidMeta.duplicateCount > 0 && (
                <p className="PyramidInspectionPanel-warning">
                  Multiple tile keys share the same payload URL — check catalog association.
                </p>
              )}

              {selectedTile ? (
                <>
                  <h3 className="PyramidInspectionPanel-sectionTitle">Selected tile</h3>
                  <dl className="PyramidInspectionPanel-dl">
                    <div>
                      <dt>Key</dt>
                      <dd>{selectedTile.key}</dd>
                    </div>
                    <div>
                      <dt>Grid ref</dt>
                      <dd>{selectedTile.gridRef}</dd>
                    </div>
                    <div>
                      <dt>Level</dt>
                      <dd>{selectedTile.level}</dd>
                    </div>
                    <div>
                      <dt>Origin</dt>
                      <dd>
                        {selectedTile.eastMin}, {selectedTile.northMin}
                      </dd>
                    </div>
                    <div>
                      <dt>Extent</dt>
                      <dd>{selectedTile.extentMetres} m</dd>
                    </div>
                    <div>
                      <dt>Channel</dt>
                      <dd>{selectedTile.channelStatus}</dd>
                    </div>
                    <div>
                      <dt>GeoLOD</dt>
                      <dd>{selectedTile.geoLodLevel}</dd>
                    </div>
                    <div>
                      <dt>Frustum</dt>
                      <dd>{selectedTile.inFrustum ? 'visible' : 'culled'}</dd>
                    </div>
                    <div>
                      <dt>Generation</dt>
                      <dd>{selectedTile.generation}</dd>
                    </div>
                    <div>
                      <dt>Encoding</dt>
                      <dd>
                        offset {selectedTile.encoding.offset}, scale {selectedTile.encoding.scale}
                      </dd>
                    </div>
                    <div>
                      <dt>Payload</dt>
                      <dd>{selectedTile.payloadUrl}</dd>
                    </div>
                    {selectedTile.texture && (
                      <div>
                        <dt>Texture</dt>
                        <dd>
                          {selectedTile.texture.width}×{selectedTile.texture.height}
                        </dd>
                      </div>
                    )}
                  </dl>
                  <div className="PyramidInspectionPanel-actions">
                    <button
                      type="button"
                      className="PyramidInspectionPanel-button"
                      onClick={refetchSelected}
                    >
                      Re-fetch channel
                    </button>
                    <button
                      type="button"
                      className="PyramidInspectionPanel-button"
                      onClick={previewSelectedTexture}
                      disabled={selectedTile.channelStatus !== 'ready'}
                    >
                      Preview texture
                    </button>
                  </div>
                </>
              ) : (
                <p className="PyramidInspectionPanel-hint">Select a tile from the list or Shift+click in the scene.</p>
              )}

              <h3 className="PyramidInspectionPanel-sectionTitle">Active tiles</h3>
              <ul className="PyramidInspectionPanel-list">
                {sortedTiles.map((tile) => (
                  <li key={tile.key}>
                    <button
                      type="button"
                      className={
                        tile.key === selectedKey
                          ? 'PyramidInspectionPanel-item PyramidInspectionPanel-item--selected'
                          : 'PyramidInspectionPanel-item'
                      }
                      onClick={() => selectTile(tile.key)}
                    >
                      <span className="PyramidInspectionPanel-itemTitle">
                        L{tile.level} {tile.gridRef}
                      </span>
                      <span className="PyramidInspectionPanel-itemMeta">
                        {tile.channelStatus} · geoLod {tile.geoLodLevel}
                        {tile.inFrustum ? '' : ' · culled'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
