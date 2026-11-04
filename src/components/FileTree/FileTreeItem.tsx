import { useState } from 'react'
import { ChevronRight, ChevronDown, File, Folder } from 'lucide-react'
import { useUIStore } from '@/store'
import { cn } from '@/lib/utils'
import { FileTree } from './FileTree'
import type { FileNode } from '@/types'

interface FileTreeItemProps {
  node: FileNode
  depth: number
}

export function FileTreeItem({ node, depth }: FileTreeItemProps) {
  const [isOpen, setIsOpen] = useState(false)
  const selectedFilePath = useUIStore((s) => s.selectedFilePath)
  const setSelectedFilePath = useUIStore((s) => s.setSelectedFilePath)

  const isSelected = selectedFilePath === node.path
  const isDirectory = node.type === 'directory'

  const handleClick = () => {
    if (isDirectory) {
      setIsOpen(!isOpen)
    } else {
      setSelectedFilePath(node.path)
    }
  }

  return (
    <>
      <div
        onClick={handleClick}
        className={cn(
          'file-tree-item',
          isSelected && 'selected'
        )}
      >
        {isDirectory ? (
          <>
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Folder size={14} className="text-leather" />
          </>
        ) : (
          <>
            <span className="w-3.5" /> {/* Spacer to align with folder arrows */}
            <File size={14} className="text-soft-charcoal/50" />
          </>
        )}
        <span className="truncate">{node.name}</span>
      </div>

      {isDirectory && isOpen && node.children && (
        <FileTree nodes={node.children} depth={depth + 1} />
      )}
      {isDirectory && isOpen && node.truncated && (
        // One level in, lined up with the icons of the files that would be there.
        <div className="text-[11px] text-soft-charcoal/40 italic py-1" style={{ paddingLeft: 42 }}>
          Too many files to list them all here
        </div>
      )}
    </>
  )
}
