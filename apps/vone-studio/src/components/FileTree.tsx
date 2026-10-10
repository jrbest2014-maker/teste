import { useState } from 'react';
import type { FsNode } from '../types/vone';
import './FileTree.css';

function FileTreeNode({ node, depth }: { node: FsNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const isDir = node.kind === 'dir';

  return (
    <div className="vone-file-node">
      <button
        className="vone-file-node__row"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => isDir && setOpen((v) => !v)}
        type="button"
      >
        <span className="vone-file-node__icon" aria-hidden="true">
          {isDir ? (open ? '▾ 📁' : '▸ 📁') : '📄'}
        </span>
        <span className="vone-file-node__name">{node.name}</span>
      </button>
      {isDir && open && node.children && (
        <div className="vone-file-node__children">
          {node.children.map((child) => (
            <FileTreeNode key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ root }: { root: FsNode }) {
  return (
    <div className="vone-file-tree">
      <FileTreeNode node={root} depth={0} />
    </div>
  );
}
