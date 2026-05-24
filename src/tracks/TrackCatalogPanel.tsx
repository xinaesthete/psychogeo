import React, { useCallback, useEffect, useState } from 'react';
import type { Track } from '../geo/TileLoaderUK';
import { GpxThumbnail } from './GpxThumbnail';
import {
    catalogItemToTrack,
    fetchTrackCatalog,
    tracksFromCatalogSelection,
    type TrackCatalogItem,
} from './trackCatalog';
import './TrackCatalogPanel.css';

export type TrackCatalogPanelProps = {
    selectedIds: ReadonlySet<string>;
    onSelectionChange: (ids: Set<string>, tracks: Track[]) => void;
};

export function TrackCatalogPanel({
    selectedIds,
    onSelectionChange,
}: TrackCatalogPanelProps) {
    const [catalog, setCatalog] = useState<TrackCatalogItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [collapsed, setCollapsed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        fetchTrackCatalog()
            .then((items) => {
                if (!cancelled) setCatalog(items);
            })
            .catch((e: unknown) => {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : 'Could not load tracks');
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const toggle = useCallback(
        (id: string) => {
            const next = new Set(selectedIds);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            onSelectionChange(next, tracksFromCatalogSelection(catalog, next));
        },
        [catalog, onSelectionChange, selectedIds],
    );

    return (
        <aside className="TrackCatalogPanel" aria-label="Track overlays">
            <header className="TrackCatalogPanel-header">
                <button
                    type="button"
                    className="TrackCatalogPanel-headerButton"
                    aria-expanded={!collapsed}
                    onClick={() => setCollapsed((value) => !value)}
                >
                    <h2 className="TrackCatalogPanel-title">Tracks</h2>
                    <span className="TrackCatalogPanel-caret" aria-hidden="true">
                        {collapsed ? '▸' : '▾'}
                    </span>
                </button>
                <span className="TrackCatalogPanel-meta">
                    {loading ? 'Loading…' : `${selectedIds.size} selected`}
                </span>
            </header>
            {!collapsed && (
                <>
                    {error && <p className="TrackCatalogPanel-error">{error}</p>}
                    <ul className="TrackCatalogPanel-list">
                        {catalog.map((item) => {
                            const selected = selectedIds.has(item.id);
                            return (
                                <li key={item.id}>
                                    <button
                                        type="button"
                                        className={
                                            selected
                                                ? 'TrackCatalogPanel-item TrackCatalogPanel-item--selected'
                                                : 'TrackCatalogPanel-item'
                                        }
                                        onClick={() => toggle(item.id)}
                                        aria-pressed={selected}
                                    >
                                        <GpxThumbnail
                                            gpxUrl={item.gpxUrl}
                                            colour={item.colour}
                                            className="TrackCatalogPanel-thumb"
                                        />
                                        <span className="TrackCatalogPanel-text">
                                            <span className="TrackCatalogPanel-name">{item.title}</span>
                                            {item.region && (
                                                <span className="TrackCatalogPanel-region">
                                                    {item.region}
                                                </span>
                                            )}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    <p className="TrackCatalogPanel-hint">
                        Catalog from API stub; thumbnails built from GPX geometry.
                    </p>
                </>
            )}
        </aside>
    );
}

/** Re-export for tests / Leva experiments. */
export { catalogItemToTrack };
