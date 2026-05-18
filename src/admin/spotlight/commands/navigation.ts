/**
 * Navigation commands — §4.1 of the Command Spotlight master plan.
 *
 * Commands that navigate between admin workspaces.
 * Gated by canAccessWorkspace so users only see accessible sections.
 */

import type { Command, CommandContext } from '../types'
import { canAccessWorkspace } from '@admin/access'

export function getNavigationCommands(): Command[] {
  return [
    {
      id: 'navigation.goToSite',
      title: 'Go to Site editor',
      subtitle: 'Open the visual page builder',
      group: 'navigation',
      iconName: 'layout-solid',
      keywords: ['site', 'editor', 'pages', 'builder', 'visual'],
      workspaces: ['any'],
      when: (ctx: CommandContext) => canAccessWorkspace(ctx.user, 'site'),
      run: (ctx) => {
        ctx.navigate('/admin/site')
        ctx.closeSpotlight()
      },
    },
    {
      id: 'navigation.goToContent',
      title: 'Go to Content',
      subtitle: 'Manage content documents',
      group: 'navigation',
      iconName: 'file-text-solid',
      keywords: ['content', 'documents', 'articles', 'cms'],
      workspaces: ['any'],
      when: (ctx: CommandContext) => canAccessWorkspace(ctx.user, 'content'),
      run: (ctx) => {
        ctx.navigate('/admin/content')
        ctx.closeSpotlight()
      },
    },
    {
      id: 'navigation.goToData',
      title: 'Go to Data',
      subtitle: 'Manage structured data tables',
      group: 'navigation',
      iconName: 'database-solid',
      keywords: ['data', 'tables', 'fields', 'database', 'structured'],
      workspaces: ['any'],
      when: (ctx: CommandContext) => canAccessWorkspace(ctx.user, 'data'),
      run: (ctx) => {
        ctx.navigate('/admin/data')
        ctx.closeSpotlight()
      },
    },
    {
      id: 'navigation.goToMedia',
      title: 'Go to Media',
      subtitle: 'Manage uploaded media files',
      group: 'navigation',
      iconName: 'image-solid',
      keywords: ['media', 'files', 'images', 'uploads', 'assets'],
      workspaces: ['any'],
      when: (ctx: CommandContext) => canAccessWorkspace(ctx.user, 'media'),
      run: (ctx) => {
        ctx.navigate('/admin/media')
        ctx.closeSpotlight()
      },
    },
    {
      id: 'navigation.goToPlugins',
      title: 'Go to Plugins',
      subtitle: 'Manage installed plugins',
      group: 'navigation',
      iconName: 'package-solid',
      keywords: ['plugins', 'extensions', 'addons', 'install'],
      workspaces: ['any'],
      when: (ctx: CommandContext) => canAccessWorkspace(ctx.user, 'plugins'),
      run: (ctx) => {
        ctx.navigate('/admin/plugins')
        ctx.closeSpotlight()
      },
    },
    {
      id: 'navigation.goToUsers',
      title: 'Go to Users',
      subtitle: 'Manage users and roles',
      group: 'navigation',
      iconName: 'cursor-minimal-solid',
      keywords: ['users', 'roles', 'team', 'members', 'permissions', 'audit'],
      workspaces: ['any'],
      when: (ctx: CommandContext) => canAccessWorkspace(ctx.user, 'users'),
      run: (ctx) => {
        ctx.navigate('/admin/users')
        ctx.closeSpotlight()
      },
    },
    {
      id: 'navigation.goToAccount',
      title: 'Go to Account',
      subtitle: 'Manage your profile and security',
      group: 'navigation',
      iconName: 'settings-cog-solid',
      keywords: ['account', 'profile', 'security', 'password', 'mfa', 'sessions'],
      workspaces: ['any'],
      when: (ctx: CommandContext) => canAccessWorkspace(ctx.user, 'account'),
      run: (ctx) => {
        ctx.navigate('/admin/account')
        ctx.closeSpotlight()
      },
    },
  ]
}
