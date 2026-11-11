// src/components/DirectoryTree.tsx
import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useStore } from "../hooks/usePhotos";
import Icon from "./Icon";
import * as api from "../api/tauri";
import { readPhotoData } from "../utils/photoRequests";

interface DirNode {
  name: string;
  relPath: string;
  children: DirNode[];
}

function buildTree(dirs: string[]): DirNode[] {
  const root: DirNode[] = [];
  const map = new Map<string, DirNode>();

  for (const dir of dirs) {
    if (!dir) continue;
    const parts = dir.split(/[\\/]/).filter(Boolean);
    let currentPath = "";

    for (const part of parts) {
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (!map.has(currentPath)) {
        const node: DirNode = { name: part, relPath: currentPath, children: [] };
        map.set(currentPath, node);

        const parent = parentPath ? map.get(parentPath) : null;
        if (parent) {
          parent.children.push(node);
        } else {
          root.push(node);
        }
      }
    }
  }

  // Sort children
  const sort = (nodes: DirNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach(n => sort(n.children));
  };
  sort(root);
  return root;
}

function DirNodeItem({ node, rootPath }: { node: DirNode; rootPath: string }) {
  const [expanded, setExpanded] = useState(false);
  const { filter, setFilter } = useStore();
  const hasChildren = node.children.length > 0;
  const fullPath = `${rootPath}/${node.relPath}`;
  const isActive = filter.directory === fullPath;

  const handleClick = useCallback(() => {
    setFilter({
      directory: fullPath,
      tag: undefined,
      person_id: undefined,
      has_gps: undefined,
      has_favorite: undefined,
      year: undefined,
      month: undefined,
      keyword: undefined,
      format: undefined,
      camera: undefined,
      iso_min: undefined,
      iso_max: undefined,
      aperture_min: undefined,
      aperture_max: undefined,
      exposure_time: undefined,
      orientation_kind: undefined,
      rating_min: undefined,
      rating_max: undefined,
    });
    if (hasChildren) setExpanded(v => !v);
  }, [fullPath, hasChildren, setFilter]);

  return (
    <div>
      <button
        onClick={handleClick}
        className={`w-full flex items-center gap-1 px-2 py-1 text-sm rounded transition-colors truncate ${
          isActive
            ? "bg-accent-primary/20 text-text-primary"
            : "text-text-secondary hover:bg-surface-primary"
        }`}
      >
        <span className="w-4 text-center text-xs shrink-0">
          {hasChildren ? (expanded ? "▾" : "▸") : " "}
        </span>
        <Icon name="folder" size={16} /><span className="truncate">{node.name}</span>
      </button>
      {expanded && hasChildren && (
        <div className="ml-4">
          {node.children.map(child => (
            <DirNodeItem key={child.relPath} node={child} rootPath={rootPath} />
          ))}
        </div>
      )}
    </div>
  );
}

interface Props { rootPath: string }

export default React.memo(function DirectoryTree({ rootPath }: Props) {
  const [dirs, setDirs] = useState<string[]>([]);
  const [directoryStatus, setDirectoryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const projectPhotoCount = useStore((state) => state.project?.total_photos);
  const { filter, clearPhotoFilters } = useStore();
  const isAllPhotos = !filter.directory
    && !filter.tag
    && filter.person_id == null
    && filter.has_gps == null
    && filter.has_favorite == null
    && filter.year == null
    && filter.month == null
    && !filter.keyword
    && !filter.format
    && !filter.camera
    && filter.iso_min == null
    && filter.iso_max == null
    && filter.aperture_min == null
    && filter.aperture_max == null
    && !filter.exposure_time
    && !filter.orientation_kind
    && filter.rating_min == null
    && filter.rating_max == null;

  useEffect(() => {
    let live = true;
    setDirectoryStatus("loading");
    readPhotoData(api.getPhotoDirectories, () => live).then((next) => {
      if (live) { setDirs(next); setDirectoryStatus("ready"); }
    }).catch(() => { if (live) setDirectoryStatus("error"); });
    return () => { live = false; };
  }, [rootPath, projectPhotoCount, attempt]);

  const tree = useMemo(() => buildTree(dirs), [dirs]);

  return (
    <div className="overflow-y-auto h-full p-2">
      <h3 className="text-xs font-semibold text-text-muted uppercase px-2 py-1">文件夹</h3>
      <button
        onClick={clearPhotoFilters}
        className={`w-full text-left px-2 py-1 text-sm rounded transition-colors truncate ${
          isAllPhotos
            ? "bg-accent-primary/20 text-text-primary"
            : "text-text-secondary hover:bg-surface-primary"
        }`}
      >
        全部照片
      </button>
      {directoryStatus === "loading" && <p role="status" className="px-2 py-2 text-xs text-text-secondary">正在读取文件夹…</p>}
      {directoryStatus === "error" && <button type="button" className="ui-button mt-2" onClick={() => setAttempt((value) => value + 1)}>重新读取文件夹</button>}
      {tree.map(node => (
        <DirNodeItem key={node.relPath} node={node} rootPath={rootPath} />
      ))}
    </div>
  );
});
