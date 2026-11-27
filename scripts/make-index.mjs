#!/usr/bin/env node
/**
 * Generate the DSH plugin-market index for this repository.
 *
 * The generated `plugin-market/index.json` can be added as a custom index source
 * in DSH (**Plugins → Discover → Add index source**) by pointing at its raw URL.
 * The version entry pins the git commit that contains the released package, so
 * run it after the release commit exists (and before publishing the index
 * commit). The index is validated with the DSH index validator when that package
 * is resolvable from `DSH_INSTALL_DIR`.
 *
 *   node scripts/make-index.mjs            # write plugin-market/index.json (git source)
 *   node scripts/make-index.mjs --npm      # list the npm release instead (after publish)
 *   node scripts/make-index.mjs --check    # validate without writing
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const repositoryUrl = 'https://github.com/ShangyuLei-HIT/dsh-remote-ssh-plugin'
const check = process.argv.includes('--check')
const npmSource = process.argv.includes('--npm')

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`unexpected commit "${commit}"`)

const dshRange = pkg.engines?.dsh ?? pkg.dsh?.engines?.dsh
const index = {
  format: 1,
  title: { en: 'ShangyuLei-HIT DSH plugins', zh: 'ShangyuLei-HIT 的 DSH 插件' },
  description: {
    en: 'Plugins for DeepSeek Harness maintained by ShangyuLei-HIT.',
    zh: 'ShangyuLei-HIT 维护的 DeepSeek Harness 插件。',
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'SSH remote development', zh: 'SSH 远程开发机' },
      description: {
        en: 'Manage SSH machines in Settings, browse remote directories over SSH, register remote workspaces, and let the agent run commands and edit files on the remote host.',
        zh: '在设置里管理 SSH 机器、通过 SSH 浏览远程目录、注册远程工作区，让 Agent 在远端主机上执行命令和编辑文件。',
      },
      icon: 'icon.svg',
      author: 'ShangyuLei-HIT',
      homepage: pkg.homepage,
      repository: { url: repositoryUrl },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: npmSource ? { type: 'npm' } : { type: 'git', url: repositoryUrl, commit },
          ...(dshRange === undefined ? {} : { engines: { dsh: dshRange } }),
        },
      ],
    },
  ],
}

const outDir = join(root, 'plugin-market')
if (!check) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  copyFileSync(join(root, 'icon.svg'), join(outDir, 'icon.svg'))
  console.log(`wrote plugin-market/index.json (${pkg.name}@${pkg.version}, ${npmSource ? 'npm source' : `commit ${commit.slice(0, 12)}`})`)
}

// Validate against the running DSH installation when available.
const dsh = process.env.DSH_INSTALL_DIR
if (dsh === undefined) {
  console.log('DSH_INSTALL_DIR is not set; skipped validator check')
  process.exit(0)
}
const validatorPath = join(dsh, '..', 'dsh-plugin-market-index', 'lib', 'index.js')
const validator = await import(pathToFileURL(validatorPath).href).catch(error => {
  console.log(`validator unavailable (${error.code ?? error.message}); skipped`)
  return undefined
})
if (validator !== undefined) {
  const indexUrl = `${repositoryUrl.replace('github.com', 'raw.githubusercontent.com')}/main/plugin-market/index.json`
  const parsed = validator.parseMarketIndex(index, indexUrl)
  console.log(`index validated: ${parsed.plugins?.[0]?.name} ${parsed.plugins?.[0]?.versions?.[0]?.version}`)
}
