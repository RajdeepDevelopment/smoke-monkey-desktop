import { ideApi, type TreeNode } from './ide-api';
import { sshApi, type SshProfile } from './ssh-api';

export type WorkspaceMode = 'local' | { profile: SshProfile };

/** Mode-aware workspace client. In remote mode all file ops go over SSH; in
 *  local mode they use the existing IDE API. The caller owns the mode switch
 *  (a toolbar control) and passes the active profile in. */
export function createWorkspaceClient(mode: WorkspaceMode) {
  const local = (mode === 'local');
  const profile = mode === 'local' ? null : mode.profile;
  const profileId = profile?.id ?? '';

  return {
    mode,
    profile,

    isRemote: () => !!profileId,

    async fileTree(root: string, depth = 2): Promise<TreeNode[]> {
      if (!profileId) return ideApi.fileTree(root, depth);
      return sshApi.fileTree(profileId, root, depth);
    },

    async readFile(path: string): Promise<{ content: string; binary: boolean; truncated: boolean }> {
      if (!profileId) return ideApi.readFile(path);
      const res = await sshApi.readRemote(profileId, path);
      return { content: res.content, binary: false, truncated: res.truncated };
    },

    async writeFile(path: string, content: string): Promise<void> {
      if (!profileId) { await ideApi.writeFile(path, content); return; }
      await sshApi.writeRemote(profileId, path, content);
    },

    async createEntry(path: string, type: 'file' | 'directory'): Promise<void> {
      if (!profileId) { await ideApi.createEntry(path, type); return; }
      await sshApi.createRemote(profileId, path, type);
    },

    async renameEntry(from: string, to: string): Promise<void> {
      if (!profileId) { await ideApi.renameEntry(from, to); return; }
      await sshApi.renameRemote(profileId, from, to);
    },

    async deleteEntry(path: string): Promise<void> {
      if (!profileId) { await ideApi.deletePath(path); return; }
      await sshApi.deleteRemote(profileId, path);
    },

    /** Alias used by the explorer context menu. */
    async deletePath(path: string): Promise<void> {
      if (!profileId) { await ideApi.deletePath(path); return; }
      await sshApi.deleteRemote(profileId, path);
    },

    /** Reveal in OS file manager. Local-only; remote is a no-op. */
    async revealInFinder(path: string): Promise<void> {
      if (!profileId) { await ideApi.revealInFinder(path); return; }
      return undefined;
    },

    async gitStatus(cwd: string) {
      if (!profileId) return ideApi.gitStatus(cwd);
      return sshApi.gitStatus(profileId, cwd);
    },
  };
}

export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
