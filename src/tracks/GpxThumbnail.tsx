import React, { useEffect, useState } from 'react';
import { fetchGpxThumbnailPath } from '../geo/gpxOutline';
import { colourToCss } from './trackCatalog';

type GpxThumbnailProps = {
    gpxUrl: string;
    colour: number;
    width?: number;
    height?: number;
    className?: string;
};

export function GpxThumbnail({
    gpxUrl,
    colour,
    width = 72,
    height = 52,
    className,
}: GpxThumbnailProps) {
    const [path, setPath] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setPath(null);
        setFailed(false);
        fetchGpxThumbnailPath(gpxUrl, width, height)
            .then((d) => {
                if (!cancelled) setPath(d);
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });
        return () => {
            cancelled = true;
        };
    }, [gpxUrl, width, height]);

    const stroke = colourToCss(colour);

    return (
        <svg
            className={className}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            aria-hidden
        >
            <rect
                width={width}
                height={height}
                rx={4}
                className="GpxThumbnail-bg"
            />
            {path && (
                <path
                    d={path}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={1.75}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            )}
            {failed && (
                <text
                    x={width / 2}
                    y={height / 2}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="GpxThumbnail-error"
                >
                    ?
                </text>
            )}
            {!path && !failed && (
                <circle
                    cx={width / 2}
                    cy={height / 2}
                    r={3}
                    className="GpxThumbnail-spinner"
                />
            )}
        </svg>
    );
}
