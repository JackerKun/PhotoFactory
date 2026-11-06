import { useState } from "react";
import type { LabelNode } from "../types";
import LabelThumb from "./LabelThumb";

interface Props {
  node: LabelNode;
  onSelectTag: (label: string) => void;
  onRename: (oldLabel: string) => void;
}

export default function LabelGroup({ node, onSelectTag, onRename }: Props) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <div className="mb-3">
      {/* Parent category row */}
      <div className="flex items-center gap-1 bg-surface-primary hover:bg-surface-secondary text-text-primary px-3 py-2 rounded-lg text-sm transition-colors group">
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-text-muted w-4 text-left select-none"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "\u25BE" : "\u25B8"}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <button
          onClick={() => onSelectTag(node.label)}
          className="flex items-center gap-2 flex-1"
        >
          <LabelThumb label={node.label} previewPath={node.preview_thumbnail} />
          <span className="font-medium">{node.label}</span>
          <span className="text-text-muted text-xs">({node.count})</span>
        </button>
        <button
          onClick={() => onRename(node.label)}
          className="text-text-muted hover:text-text-primary text-xs opacity-0 group-hover:opacity-100 transition-opacity"
        >
          Edit
        </button>
      </div>

      {/* Child labels */}
      {expanded && hasChildren && (
        <div className="flex flex-wrap gap-2 ml-6 mt-2">
          {node.children.map((child) => (
            <div
              key={child.label}
              className="flex items-center gap-1 bg-surface-secondary hover:bg-bg-tertiary text-text-primary px-3 py-1.5 rounded-lg text-sm transition-colors group"
            >
              <button
                onClick={() => onSelectTag(child.label)}
                className="flex items-center gap-2"
              >
                <LabelThumb label={child.label} previewPath={child.preview_thumbnail} />
                {child.label}
                <span className="text-text-muted text-xs">({child.count})</span>
              </button>
              <button
                onClick={() => onRename(child.label)}
                className="text-text-muted hover:text-text-primary text-xs opacity-0 group-hover:opacity-100 transition-opacity"
              >
                Edit
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
