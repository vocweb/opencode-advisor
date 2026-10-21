import fs from "node:fs"
import path from "node:path"

const hasGit = (dir: string): boolean => fs.existsSync(path.join(dir, ".git"))

/**
 * If `directory` is not inside a Git repository and has exactly one direct child that is a repository, return that child's name.
 * Pure filesystem look-up so both hosts behave the same.
 */
export function childRepository(directory: string): string | undefined {
  try {
    // 上位に .git があるなら普通のプロジェクトなので、子リポジトリの案内は不要。
    // Nếu ở trên có .git thì đây là project bình thường, không cần chỉ ra repo con.
    for (let cur = path.resolve(directory); ; ) {
      if (hasGit(cur)) return undefined
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    const kids = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && hasGit(path.join(directory, e.name)))
      .map((e) => e.name)
    return kids.length === 1 ? kids[0] : undefined
  } catch {
    return undefined
  }
}

/** The extra guidance block for the advisor's system prompt, or an empty string. */
export function childRepositoryBlock(directory: string): string {
  const name = childRepository(directory)
  return name ? `The session directory is not a Git repository. Its only child repository is \`${name}/\`; treat that as the active project.` : ""
}
