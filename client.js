/**
 * SSH remote development — browser half.
 *
 * Settings section (`settings.section` id `ssh-remote`) that manages the machine
 * registry, the remote working directory of every machine, and the mirror
 * workspaces the Host registers in the Workspaces list. All state lives on the
 * Host under `/api/ssh-remote`; this module renders it and keeps every action
 * one request away.
 *
 * Interaction model:
 *   - one primary action per surface (add machine / test connection / choose a
 *     remote directory), everything else secondary;
 *   - a machine is created and its directory chosen in one dialog — the dialog
 *     can browse the remote filesystem before anything is saved;
 *   - the panel reports every mutation with an auto-dismissing status line and a
 *     machine-level connection state;
 *   - the browser dialog is keyboard-operable (Escape closes, Enter opens a
 *     typed path), supports home/root jumps, hidden-directory toggle, an
 *     explicit selection, and inline folder creation.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-ssh-remote',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const NS = 'sshRemote'
    const API_PATH = (() => {
      try { return new URL('api/ssh-remote', document.baseURI).pathname } catch { return '/api/ssh-remote' }
    })()

    const DICT = {
      zh: {
        'title': 'SSH 远程开发机',
        'subtitle': '管理 SSH 机器与它们的远程工作目录。选定目录会自动注册成工作区（形如 “SSH · 机器 · 路径”），在该工作区下新建的会话默认就在这个远程目录工作。',
        'refresh': '刷新',
        'testAll': '全部检测',
        'add': '添加机器',
        'machinesTitle': '机器',
        'machinesHint': 'Agent 在对话中通过 remote_* 工具使用这些机器。',
        'empty': '还没有配置机器',
        'emptyHint': '添加一台 SSH 机器后，选择一个远程目录即可开始。',
        'machineId': '机器名称',
        'machineIdHint': '对话与 host 参数里使用的名字',
        'idPlaceholder': '例如 gpu',
        'host': 'SSH 目标',
        'hostHint': '~/.ssh/config 里的别名，或 user@host',
        'hostPlaceholder': '例如 gpu-box 或 root@10.0.0.12',
        'workspace': '远程工作目录',
        'workspaceHint': '选择后自动创建工作区；相对路径与 remote_exec 默认在此目录执行',
        'notChosen': '未选择',
        'chooseDir': '选择目录',
        'browseRemote': '浏览远程目录',
        'clear': '清除',
        'optional': '可选',
        'edit': '编辑',
        'remove': '删除',
        'confirmRemove': '确认删除',
        'removeMachineWarn': '删除机器会一并删除它的远程工作区（本机镜像目录保留）。',
        'cancel': '取消',
        'save': '保存',
        'saving': '保存中…',
        'addMachineTitle': '添加 SSH 机器',
        'editMachineTitle': '编辑机器',
        'attachWorkspaceNote': '保存时会验证远程目录并自动注册工作区；也可以先只保存机器。',
        'updateWorkspaceNote': '保存时会验证新目录并注册对应工作区。',
        'test': '测试连接',
        'testing': '检测中…',
        'statusIdle': '未检测',
        'connected': '连接正常',
        'notAvailable': '无法连接',
        'primary': '主机器',
        'primaryHint': '未指定 host 时默认使用它',
        'deleteWorkspaceNote': '只删除工作区绑定，不影响机器。',
        'refreshTitle': '重新读取机器与工作区',
        'probeAllTitle': '逐个检测所有机器的 SSH 连接',
        'browseTitle': '选择远程目录',
        'browseSubtitle': '单击选中目录，双击进入；“用这个目录”会把当前选择设为工作目录。',
        'home': '主目录',
        'root': '根目录',
        'up': '上一级',
        'open': '打开',
        'pathPlaceholder': '/root',
        'chooseThis': '用这个目录',
        'currentSelection': '当前选择',
        'newFolder': '新建文件夹',
        'folderName': '目录名',
        'create': '创建',
        'creating': '创建中…',
        'showHidden': '包含隐藏目录',
        'hideHidden': '隐藏隐藏目录',
        'loading': '加载中…',
        'loadFailed': '读取失败',
        'retry': '重试',
        'saved': '已保存',
        'workspaceCreated': '已创建工作区',
        'workspaceRegistered': '已注册',
        'workspaceUnregistered': '未注册',
        'registerWorkspace': '重新注册',
        'workspacesTitle': '远程工作区',
        'workspacesHint': '这些工作区出现在新建会话的工作区列表里；在某个工作区下新建的会话绑定到对应远程目录，本地文件/shell 工具会被隐藏。',
        'emptyWorkspaces': '还没有远程工作区。为机器选择一个远程目录即可自动创建。',
        'mirror': '本地镜像',
        'stateFile': '机器与绑定保存在',
        'localPickerNote': '系统“新建会话”的工作区选择器只列本地目录；远程目录请在上方选择，工作区列表会自动出现对应条目。',
        'toolsHint': '在对话里直接说“在 <机器> 的 <目录> 里做某事”，Agent 会调用 remote_exec / remote_read / remote_edit 等工具。',
        'removed': '已删除',
        'dismiss': '关闭提示',
        'registeredNotice': '已重新注册工作区',
        'noWorkspaceYet': '尚未设置远程目录',
        'formInvalidId': '机器名称不能为空，且不能是 default。',
        'formInvalidHost': 'SSH 目标不能为空。',
        'lastMachineHint': '至少要保留一台机器；先添加另一台再删除。',
        'errDirNotFound': '远程目录不存在',
        'errLastMachine': '至少要保留一台机器。',
        'errMachineExists': '同名机器已存在，请换一个名称。',
        'errUnknownMachine': '找不到这台机器，可能已被删除。',
        'errNotFound': '远程路径不存在',
        'browseNeedsHost': '先填写 SSH 目标才能浏览远程目录。',
      },
      en: {
        'title': 'SSH remote development',
        'subtitle': 'Manage SSH machines and their remote working directories. Choosing a directory registers a workspace named “SSH · machine · path”; sessions opened in that workspace default to the remote directory.',
        'refresh': 'Refresh',
        'testAll': 'Test all',
        'add': 'Add machine',
        'machinesTitle': 'Machines',
        'machinesHint': 'The agent uses these machines through the remote_* tools.',
        'empty': 'No machine configured yet',
        'emptyHint': 'Add an SSH machine, then choose a remote directory to start.',
        'machineId': 'Machine name',
        'machineIdHint': 'Name used in chat and the host argument',
        'idPlaceholder': 'e.g. gpu',
        'host': 'SSH destination',
        'hostHint': 'Alias from ~/.ssh/config, or user@host',
        'hostPlaceholder': 'e.g. gpu-box or root@10.0.0.12',
        'workspace': 'Remote working directory',
        'workspaceHint': 'Choosing one registers a workspace; relative paths and remote_exec default here',
        'notChosen': 'Not chosen',
        'chooseDir': 'Choose directory',
        'browseRemote': 'Browse remote directory',
        'clear': 'Clear',
        'optional': 'optional',
        'edit': 'Edit',
        'remove': 'Remove',
        'confirmRemove': 'Confirm remove',
        'removeMachineWarn': 'Removing the machine also removes its remote workspaces (local mirror directories are kept).',
        'cancel': 'Cancel',
        'save': 'Save',
        'saving': 'Saving…',
        'addMachineTitle': 'Add SSH machine',
        'editMachineTitle': 'Edit machine',
        'attachWorkspaceNote': 'Saving verifies the remote directory and registers its workspace; you can also save the machine alone first.',
        'updateWorkspaceNote': 'Saving verifies the new directory and registers the matching workspace.',
        'test': 'Test connection',
        'testing': 'Testing…',
        'statusIdle': 'Not tested',
        'connected': 'Connected',
        'notAvailable': 'Unable to connect',
        'primary': 'Primary',
        'primaryHint': 'Used when a tool call omits host',
        'deleteWorkspaceNote': 'Removes the workspace binding only; the machine stays configured.',
        'refreshTitle': 'Reload machines and workspaces',
        'probeAllTitle': 'Test the SSH connection of every machine',
        'browseTitle': 'Choose a remote directory',
        'browseSubtitle': 'Click to select, double-click to enter; “Use this directory” sets the current selection as the working directory.',
        'home': 'Home',
        'root': 'Root',
        'up': 'Up',
        'open': 'Open',
        'pathPlaceholder': '/root',
        'chooseThis': 'Use this directory',
        'currentSelection': 'Selected',
        'newFolder': 'New folder',
        'folderName': 'Folder name',
        'create': 'Create',
        'creating': 'Creating…',
        'showHidden': 'Show hidden directories',
        'hideHidden': 'Hide hidden directories',
        'loading': 'Loading…',
        'loadFailed': 'Could not load',
        'retry': 'Retry',
        'saved': 'Saved',
        'workspaceCreated': 'Workspace created',
        'workspaceRegistered': 'Registered',
        'workspaceUnregistered': 'Not registered',
        'registerWorkspace': 'Register again',
        'workspacesTitle': 'Remote workspaces',
        'workspacesHint': 'These workspaces appear in the new-session workspace list; a session opened in one is bound to that remote directory and the local file/shell tools are hidden.',
        'emptyWorkspaces': 'No remote workspace yet. Choose a remote directory for a machine to create one.',
        'mirror': 'Local mirror',
        'stateFile': 'Machines and bindings saved in',
        'localPickerNote': 'The session workspace picker lists local directories only; choose the remote directory above and its workspace appears in the Workspaces list.',
        'toolsHint': 'Ask in chat to work on “machine in directory” and the agent calls remote_exec / remote_read / remote_edit.',
        'removed': 'Removed',
        'dismiss': 'Dismiss',
        'registeredNotice': 'Workspace registered again',
        'noWorkspaceYet': 'No remote working directory yet',
        'formInvalidId': 'Machine name must not be empty or "default".',
        'formInvalidHost': 'SSH destination must not be empty.',
        'lastMachineHint': 'Keep at least one machine; add another before removing this one.',
        'errDirNotFound': 'Remote directory not found',
        'errLastMachine': 'At least one machine must remain.',
        'errMachineExists': 'A machine with this name already exists; choose another name.',
        'errUnknownMachine': 'That machine no longer exists.',
        'errNotFound': 'Remote path not found',
        'browseNeedsHost': 'Fill in the SSH destination before browsing.',
      },
    }

    // Only tokens that exist in the installed theme sheets (design-platform.css /
    // base.css / focus.css) are referenced here; a misspelled token silently
    // inherits the wrong colour instead of failing loud.
    const COLOR = {
      text: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      layer3: 'var(--dsw-alias-bg-layer-3)',
      mask: 'var(--dsw-alias-bg-mask-1)',
      accent: 'var(--dsw-alias-button-primary-fill)',
      onAccent: 'var(--dsw-alias-label-primary-foreground)',
      success: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warning: 'var(--dsw-alias-state-warn-primary)',
      warningText: 'var(--dsw-alias-state-warn-label)',
      selection: 'var(--dsw-alias-bg-multi-select)',
      cardStroke: 'var(--dsw-alias-settings-card-stroke)',
      cardFill: 'var(--dsw-alias-settings-card-fill)',
      radiusLg: 'var(--dsw-radius-lg)',
      radiusXl: 'var(--dsw-radius-xl)',
      elevation: 'var(--dsw-elevation-prominent)',
    }

    const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    const buttonStyle = (kind = 'secondary', options = {}) => ({
      appearance: 'none',
      font: 'inherit',
      fontSize: options.small === true ? 12 : 13,
      lineHeight: 1.2,
      padding: options.small === true ? '5px 9px' : '7px 13px',
      borderRadius: 8,
      cursor: options.disabled === true ? 'default' : 'pointer',
      opacity: options.disabled === true ? 0.5 : 1,
      border: `1px solid ${kind === 'primary' ? 'transparent' : kind === 'danger' ? COLOR.error : COLOR.borderStrong}`,
      background: kind === 'primary' ? COLOR.accent : 'transparent',
      color: kind === 'primary' ? COLOR.onAccent : kind === 'danger' ? COLOR.error : COLOR.text,
      whiteSpace: 'nowrap',
    })

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      font: 'inherit',
      fontSize: 13,
      padding: '8px 10px',
      borderRadius: 8,
      border: `1px solid ${COLOR.borderStrong}`,
      background: COLOR.layer2,
      color: COLOR.text,
    }

    const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: COLOR.secondary, marginBottom: 5 }
    const hintStyle = { fontSize: 12, color: COLOR.tertiary, lineHeight: 1.5 }
    const monoStyle = { fontFamily: FONT_MONO, fontSize: 12, wordBreak: 'break-all' }

    const cardStyle = {
      border: `0.5px solid ${COLOR.cardStroke}`,
      borderRadius: COLOR.radiusXl,
      background: COLOR.cardFill,
      padding: '13px 15px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }

    function chip(text, tone) {
      const color = tone === 'success' ? COLOR.success : tone === 'error' ? COLOR.error : tone === 'warning' ? COLOR.warningText : COLOR.secondary
      return h('span', {
        style: {
          fontSize: 11,
          lineHeight: '16px',
          padding: '0 7px',
          borderRadius: 999,
          border: `1px solid ${tone === 'success' ? COLOR.success : tone === 'error' ? COLOR.error : tone === 'warning' ? COLOR.warning : COLOR.borderStrong}`,
          color,
          whiteSpace: 'nowrap',
        },
      }, text)
    }

    async function callApi(path, body, timeoutMs = 25_000) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const request = {
          redirect: 'error',
          signal: controller.signal,
        }
        if (body !== undefined) {
          request.method = 'POST'
          request.headers = { 'content-type': 'application/json' }
          request.body = JSON.stringify(body)
        }
        const response = await fetch(`${API_PATH}${path}`, request)
        const text = await response.text()
        let payload = {}
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    /** Translate the backend's stable English diagnostics into the panel language. */
    function friendlyError(t, error) {
      const message = String(error?.message ?? error ?? '')
      if (/Remote directory not found/i.test(message)) return `${t('errDirNotFound')}: ${message.replace(/^.*?:\s*/, '')}`
      if (/at least one machine must remain/i.test(message)) return t('errLastMachine')
      if (/already exists/i.test(message)) return t('errMachineExists')
      if (/Unknown machine/i.test(message)) return t('errUnknownMachine')
      if (/not found/i.test(message)) return `${t('errNotFound')}: ${message}`
      return message
    }

    function Spinner({ t, inline }) {
      return h('span', { style: { ...hintStyle, padding: inline === true ? 0 : '8px 0' } }, t('loading'))
    }

    /** Small icon-free section header with optional actions. */
    function Section({ title, hint, actions, children, t }) {
      return h('section', { style: { marginTop: 22 } }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 },
        }, [
          h('div', { key: 'text' }, [
            h('div', { key: 'title', style: { fontSize: 14, fontWeight: 600, color: COLOR.text } }, title),
            hint === undefined ? null : h('div', { key: 'hint', style: { ...hintStyle, marginTop: 2 } }, hint),
          ]),
          actions === undefined ? null : h('div', { key: 'actions', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, actions),
        ]),
        h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: 10 } }, children),
      ])
    }

    /**
     * Modal plumbing.
     *
     * Dialogs are stacked so one Escape closes only the front dialog and never
     * falls through to the Settings shell (which also closes on Escape). The
     * first dialog locks page scrolling; the last one restores it, returns focus
     * to the element that opened it, and Tab stays inside the panel.
     */
    const modalStack = []
    let restoreOverflow
    const hasDocument = () => {
      try { return typeof document !== 'undefined' && document !== null } catch { return false }
    }
    const focusablesIn = panel => {
      if (panel === undefined || panel === null || typeof panel.querySelectorAll !== 'function') return []
      return [...panel.querySelectorAll('button:not([disabled]),input:not([disabled]):not([readonly]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')]
    }
    function pushModal(onClose) {
      modalStack.push(onClose)
      if (!hasDocument()) return
      if (modalStack.length === 1) {
        restoreOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const handler = event => {
          if (event.key !== 'Escape' || modalStack.length === 0) return
          event.preventDefault()
          event.stopImmediatePropagation()
          modalStack[modalStack.length - 1]()
        }
        modalStack.handler = handler
        document.addEventListener('keydown', handler, true)
      }
    }
    function popModal(onClose) {
      const index = modalStack.lastIndexOf(onClose)
      if (index >= 0) modalStack.splice(index, 1)
      if (!hasDocument() || modalStack.length !== 0) return
      if (modalStack.handler !== undefined) {
        document.removeEventListener('keydown', modalStack.handler, true)
        modalStack.handler = undefined
      }
      if (restoreOverflow !== undefined) {
        document.body.style.overflow = restoreOverflow
        restoreOverflow = undefined
      }
    }

    /** Modal shell: stacked Escape handling, focus return, Tab containment. */
    function Modal({ title, subtitle, t, level, children, footer, onClose }) {
      const panelRef = useRef(undefined)
      useEffect(() => {
        const previous = hasDocument() ? document.activeElement : undefined
        pushModal(onClose)
        let timer
        if (hasDocument()) {
          timer = setTimeout(() => {
            const first = focusablesIn(panelRef.current)[0]
            if (first !== undefined && typeof first.focus === 'function') first.focus()
          }, 0)
        }
        return () => {
          if (timer !== undefined) clearTimeout(timer)
          popModal(onClose)
          if (previous !== undefined && previous !== null && typeof previous.focus === 'function') {
            try { previous.focus() } catch { /* the opener is gone */ }
          }
        }
      }, [onClose])
      const trapTab = event => {
        if (event.key !== 'Tab' || !hasDocument()) return
        const focusables = focusablesIn(panelRef.current)
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
      return h('div', {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: level ?? 1000,
          background: COLOR.mask,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        },
        onMouseDown: event => { if (event.target === event.currentTarget) onClose() },
      }, h('div', {
        ref: panelRef,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        onKeyDown: trapTab,
        style: {
          width: 'min(660px, 100%)',
          maxHeight: '84vh',
          display: 'flex',
          flexDirection: 'column',
          background: COLOR.layer1,
          border: `1px solid ${COLOR.borderStrong}`,
          borderRadius: COLOR.radiusLg,
          boxShadow: COLOR.elevation,
          overflow: 'hidden',
        },
      }, [
        h('div', {
          key: 'head',
          style: { padding: '15px 18px 11px', borderBottom: `1px solid ${COLOR.border}` },
        }, [
          h('div', { key: 'title', style: { fontSize: 15, fontWeight: 600, color: COLOR.text } }, title),
          subtitle === undefined ? null : h('div', { key: 'sub', style: { ...hintStyle, marginTop: 4 } }, subtitle),
        ]),
        h('div', { key: 'body', style: { padding: '14px 18px', overflow: 'auto' } }, children),
        footer === undefined ? null : h('div', {
          key: 'foot',
          style: { padding: '12px 18px', borderTop: `1px solid ${COLOR.border}`, display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' },
        }, footer),
      ]))
    }

    /** Machine connection state as a compact pill, including the probe detail. */
    function StatusPill({ status, t }) {
      if (status === undefined) return h('span', { style: { ...hintStyle, fontStyle: 'italic' } }, t('statusIdle'))
      if (status.kind === 'pending') return h('span', { style: { fontSize: 12, color: COLOR.secondary } }, t('testing'))
      const detail = String(status.detail ?? '')
      if (status.kind === 'ok') {
        const label = `${t('connected')} · ${detail === '' ? '' : `${detail} · `}${status.latencyMs ?? 0}ms`
        return h('span', { title: label }, chip(label, 'success'))
      }
      const short = detail.length > 40 ? `${detail.slice(0, 40)}…` : detail
      return h('span', {
        title: detail === '' ? t('notAvailable') : detail,
        style: { fontSize: 12, color: COLOR.error, cursor: 'help', wordBreak: 'break-word' },
      }, `${t('notAvailable')}${short === '' ? '' : ` · ${short}`}`)
    }

    /** One machine card: identity, destination, remote directory, actions. */
    function MachineCard({ machine, status, t, busy, canRemove, onTest, onBrowse, onEdit, onRemove }) {
      const [confirming, setConfirming] = useState(false)
      useEffect(() => {
        if (!confirming) return undefined
        // An unread confirm is safer retracted after a while than left armed.
        const timer = setTimeout(() => setConfirming(false), 6000)
        return () => clearTimeout(timer)
      }, [confirming])
      const probing = status?.kind === 'pending'
      const disabled = probing || busy
      const actions = confirming
        ? h('div', {
          key: 'confirm',
          style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' },
        }, [
          h('span', { key: 'warn', style: { fontSize: 12, color: COLOR.warningText, maxWidth: 320, lineHeight: 1.5 } }, t('removeMachineWarn')),
          h('button', {
            key: 'yes', type: 'button', style: buttonStyle('danger', { small: true }),
            onClick: () => { setConfirming(false); onRemove() },
          }, t('confirmRemove')),
          h('button', { key: 'no', type: 'button', style: buttonStyle('secondary', { small: true }), onClick: () => setConfirming(false) }, t('cancel')),
        ])
        : h('div', { key: 'row', style: { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' } }, [
          h('button', {
            key: 'test', type: 'button',
            style: buttonStyle('secondary', { small: true, disabled }),
            disabled,
            onClick: onTest,
          }, probing ? t('testing') : t('test')),
          h('button', { key: 'browse', type: 'button', style: buttonStyle('secondary', { small: true, disabled }), disabled, onClick: onBrowse }, t('chooseDir')),
          h('button', { key: 'edit', type: 'button', style: buttonStyle('secondary', { small: true, disabled }), disabled, onClick: onEdit }, t('edit')),
          h('button', {
            key: 'remove',
            type: 'button',
            style: buttonStyle('danger', { small: true, disabled: disabled || !canRemove }),
            disabled: disabled || !canRemove,
            title: canRemove ? t('removeMachineWarn') : t('lastMachineHint'),
            onClick: () => setConfirming(true),
          }, t('remove')),
        ])
      return h('div', { style: cardStyle }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
        }, [
          h('div', { key: 'name', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 } }, [
            h('span', { key: 'id', style: { fontSize: 14, fontWeight: 600, color: COLOR.text } }, machine.id),
            machine.primary === true ? h('span', { key: 'primary', title: t('primaryHint') }, chip(t('primary'))) : null,
            h(StatusPill, { key: 'status', status, t }),
          ]),
        ]),
        h('div', {
          key: 'meta',
          style: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '4px 12px', alignItems: 'baseline' },
        }, [
          h('span', { key: 'hostL', style: { ...hintStyle, whiteSpace: 'nowrap' } }, t('host')),
          h('span', { key: 'hostV', style: { ...monoStyle, color: COLOR.text } }, machine.host),
          h('span', { key: 'wsL', style: { ...hintStyle, whiteSpace: 'nowrap' } }, t('workspace')),
          h('span', {
            key: 'wsV',
            style: { ...monoStyle, color: machine.workspace === '' ? COLOR.tertiary : COLOR.text },
          }, machine.workspace === '' ? t('noWorkspaceYet') : machine.workspace),
        ]),
        actions,
      ])
    }

    /** Create/edit dialog: machine identity plus its remote directory in one step. */
    function MachineModal({ mode, machine, t, onClose, onSaved, onBrowse }) {
      const editing = mode === 'edit'
      const [id, setId] = useState(machine?.id ?? '')
      const [host, setHost] = useState(machine?.host ?? '')
      const [workspace, setWorkspace] = useState(machine?.workspace ?? '')
      const [idTouched, setIdTouched] = useState(editing)
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(undefined)

      const deriveId = value => value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')

      const submit = () => {
        const machineId = id.trim()
        if (machineId === '' || machineId === 'default') { setError(t('formInvalidId')); return }
        if (host.trim() === '') { setError(t('formInvalidHost')); return }
        setSaving(true)
        setError(undefined)
        callApi('/machines', {
          action: editing ? 'update' : 'create',
          machine: { id: machineId, host: host.trim(), workspace: workspace.trim() },
        }, 40_000)
          .then(payload => onSaved(payload))
          .catch(cause => { setError(friendlyError(t, cause)); setSaving(false) })
      }

      const workspaceRow = h('div', {
        key: 'workspace',
        style: { border: `1px solid ${COLOR.border}`, borderRadius: 10, padding: '10px 12px', background: COLOR.layer2 },
      }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } }, [
          h('div', { key: 'label', style: { fontSize: 12, fontWeight: 500, color: COLOR.secondary } }, `${t('workspace')} · ${t('optional')}`),
          h('div', { key: 'actions', style: { display: 'flex', gap: 6 } }, [
            workspace === '' ? null : h('button', {
              key: 'clear', type: 'button', style: buttonStyle('secondary', { small: true }),
              onClick: () => setWorkspace(''),
            }, t('clear')),
            h('button', {
              key: 'browse', type: 'button', style: buttonStyle('secondary', { small: true }),
              onClick: () => {
                if (host.trim() === '') { setError(t('browseNeedsHost')); return }
                setError(undefined)
                onBrowse({ id: id.trim() || deriveId(host), host: host.trim(), workspace: workspace.trim() }, path => setWorkspace(path))
              },
            }, t('browseRemote')),
          ]),
        ]),
        h('div', { key: 'value', style: { ...monoStyle, marginTop: 6, color: workspace === '' ? COLOR.tertiary : COLOR.text } }, workspace === '' ? t('notChosen') : workspace),
        h('div', { key: 'hint', style: { ...hintStyle, marginTop: 4 } }, t('workspaceHint')),
      ])

      const footer = [
        h('button', { key: 'cancel', type: 'button', style: buttonStyle(), onClick: onClose }, t('cancel')),
        h('button', {
          key: 'save', type: 'button',
          style: buttonStyle('primary', { disabled: saving }),
          disabled: saving,
          onClick: submit,
        }, saving ? t('saving') : t('save')),
      ]

      return h(Modal, {
        title: editing ? `${t('editMachineTitle')} · ${machine.id}` : t('addMachineTitle'),
        subtitle: editing ? t('updateWorkspaceNote') : t('attachWorkspaceNote'),
        t,
        onClose,
        footer,
      }, h('div', {
        onKeyDown: event => {
          if (event.key === 'Enter' && event.target && event.target.tagName === 'INPUT') {
            event.preventDefault()
            submit()
          }
        },
      }, [
        h('div', { key: 'id', style: { marginBottom: 12 } }, [
          h('label', { key: 'label', style: labelStyle, htmlFor: 'ssh-remote-id' }, `${t('machineId')} · ${t('machineIdHint')}`),
          h('input', {
            key: 'input', id: 'ssh-remote-id', style: { ...inputStyle, fontFamily: FONT_MONO },
            value: id, placeholder: t('idPlaceholder'), spellCheck: false, autoFocus: !editing,
            readOnly: editing,
            onChange: event => { setIdTouched(true); setId(event.target.value) },
          }),
        ]),
        h('div', { key: 'host', style: { marginBottom: 12 } }, [
          h('label', { key: 'label', style: labelStyle, htmlFor: 'ssh-remote-host' }, `${t('host')} · ${t('hostHint')}`),
          h('input', {
            key: 'input', id: 'ssh-remote-host', style: { ...inputStyle, fontFamily: FONT_MONO },
            value: host, placeholder: t('hostPlaceholder'), spellCheck: false,
            autoFocus: editing,
            onChange: event => {
              const value = event.target.value
              setHost(value)
              if (!idTouched) setId(deriveId(value))
            },
          }),
        ]),
        workspaceRow,
        error === undefined ? null : h('div', { key: 'error', role: 'alert', style: { marginTop: 10, fontSize: 12, color: COLOR.error, lineHeight: 1.5 } }, error),
      ]))
    }

    /** Remote directory browser: home/root jumps, breadcrumb, selection, folder creation. */
    function BrowserModal({ target, t, level, busy, onClose, onPick }) {
      const [listing, setListing] = useState(undefined)
      const [pathInput, setPathInput] = useState(target.workspace ?? '')
      const [selected, setSelected] = useState(undefined)
      const [showHidden, setShowHidden] = useState(false)
      const [pending, setPending] = useState(false)
      const [error, setError] = useState(undefined)
      const [creating, setCreating] = useState(false)
      const [newName, setNewName] = useState('')
      const [busyCreate, setBusyCreate] = useState(false)

      const load = useCallback(path => {
        setPending(true)
        setError(undefined)
        callApi('/browse', { id: target.id, host: target.host, path: path ?? '' }, 30_000)
          .then(payload => {
            setListing(payload)
            setPathInput(payload.path)
            setSelected(payload.path)
            setCreating(false)
          })
          .catch(cause => setError(friendlyError(t, cause)))
          .finally(() => setPending(false))
      }, [target.id, target.host, t])

      useEffect(() => { load(target.workspace ?? '') }, [load, target.workspace])

      const createFolder = () => {
        const name = newName.trim()
        if (name === '') return
        setBusyCreate(true)
        setError(undefined)
        callApi('/mkdir', { id: target.id, host: target.host, path: listing?.path ?? '', name })
          .then(created => { setCreating(false); setNewName(''); load(created.path) })
          .catch(cause => setError(friendlyError(t, cause)))
          .finally(() => setBusyCreate(false))
      }

      const crumbs = listing?.crumbs ?? []
      const entries = (listing?.entries ?? []).filter(entry => entry.isDirectory && (showHidden || !entry.hidden))
      const selection = selected ?? listing?.path

      const footer = [
        h('div', { key: 'selected', style: { marginRight: 'auto', display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 } }, [
          h('span', { key: 'label', style: { ...hintStyle, whiteSpace: 'nowrap' } }, `${t('currentSelection')}:`),
          h('span', { key: 'value', style: { ...monoStyle, color: COLOR.text } }, selection ?? '—'),
        ]),
        h('button', { key: 'cancel', type: 'button', style: buttonStyle('secondary', { disabled: busy }), disabled: busy, onClick: onClose }, t('cancel')),
        h('button', {
          key: 'pick', type: 'button',
          style: buttonStyle('primary', { disabled: busy || pending || selection === undefined }),
          disabled: busy || pending || selection === undefined,
          onClick: () => onPick(selection),
        }, busy ? t('saving') : t('chooseThis')),
      ]

      const navButton = (label, onClick, disabled) => h('button', {
        type: 'button', style: buttonStyle('secondary', { small: true, disabled }), disabled, onClick,
      }, label)

      return h(Modal, {
        title: `${t('browseTitle')} · ${target.label ?? target.id}`,
        subtitle: t('browseSubtitle'),
        t,
        level,
        onClose,
        footer,
      }, [
        h('div', { key: 'bar', style: { display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' } }, [
          navButton(t('home'), () => load(listing?.home ?? ''), pending),
          navButton(t('root'), () => load('/'), pending),
          navButton(t('up'), () => load(listing?.parent ?? ''), pending),
          h('div', { key: 'path', style: { display: 'flex', gap: 6, flex: '1 1 260px', minWidth: 0 } }, [
            h('input', {
              key: 'input',
              style: { ...inputStyle, flex: 1, fontFamily: FONT_MONO },
              value: pathInput,
              placeholder: t('pathPlaceholder'),
              spellCheck: false,
              autoFocus: true,
              onChange: event => setPathInput(event.target.value),
              onKeyDown: event => { if (event.key === 'Enter') load(pathInput) },
            }),
            h('button', {
              key: 'go', type: 'button',
              style: buttonStyle('secondary', { small: true, disabled: pending }),
              disabled: pending,
              onClick: () => load(pathInput),
            }, t('open')),
          ]),
        ]),
        h('div', { key: 'crumbs', style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 } },
          crumbs.map(crumb => h('button', {
            key: crumb.path,
            type: 'button',
            style: {
              ...buttonStyle('secondary', { small: true }),
              border: 'none',
              padding: '3px 7px',
              color: crumb.path === listing?.path ? COLOR.accent : COLOR.secondary,
            },
            onClick: () => load(crumb.path),
          }, crumb.name))),
        h('div', {
          key: 'list',
          style: { border: `1px solid ${COLOR.border}`, borderRadius: 10, background: COLOR.layer2, maxHeight: '38vh', minHeight: 120, overflow: 'auto' },
        }, [
          pending && listing === undefined ? h(Spinner, { key: 'loading', t }) : null,
          error !== undefined
            ? h('div', { key: 'error', style: { padding: 14 } }, [
              h('div', { key: 'text', style: { fontSize: 12, color: COLOR.error, marginBottom: 8 } }, `${t('loadFailed')}: ${error}`),
              h('button', { key: 'retry', type: 'button', style: buttonStyle('secondary', { small: true }), onClick: () => load(listing?.path ?? target.workspace ?? '') }, t('retry')),
            ])
            : null,
          error === undefined && entries.length === 0 && !pending
            ? h('div', { key: 'empty', style: { ...hintStyle, padding: 14 } }, '—')
            : entries.map(entry => h('div', {
              key: entry.path,
              role: 'button',
              tabIndex: 0,
              'aria-label': `${entry.name}${selection === entry.path ? ` — ${t('currentSelection')}` : ''}`,
              onClick: () => setSelected(entry.path),
              onDoubleClick: () => load(entry.path),
              onKeyDown: event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  if (selection === entry.path) load(entry.path)
                  else setSelected(entry.path)
                }
              },
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                cursor: 'pointer',
                borderBottom: `1px solid ${COLOR.border}`,
                fontSize: 13,
                color: entry.hidden ? COLOR.tertiary : COLOR.text,
                background: selection === entry.path ? COLOR.selection : 'transparent',
              },
            }, [
              h('span', { key: 'icon', style: { ...hintStyle, width: 12 } }, selection === entry.path ? '▸' : ''),
              h('span', { key: 'name', style: { flex: 1, wordBreak: 'break-all' } }, `${entry.name}/`),
              h('span', { key: 'enter', style: { ...hintStyle, padding: '2px 6px' } }, '↗'),
            ]))
        ]),
        h('div', { key: 'tools', style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' } }, [
          h('button', {
            key: 'hidden',
            type: 'button',
            role: 'switch',
            'aria-checked': showHidden,
            'aria-label': t('showHidden'),
            style: buttonStyle('secondary', { small: true }),
            onClick: () => setShowHidden(value => !value),
          }, showHidden ? `✓ ${t('hideHidden')}` : `○ ${t('showHidden')}`),
          h('button', {
            key: 'new', type: 'button', style: buttonStyle('secondary', { small: true, disabled: pending }),
            disabled: pending,
            onClick: () => setCreating(value => !value),
          }, t('newFolder')),
          creating
            ? h('div', { key: 'create', style: { display: 'flex', gap: 6, flex: '1 1 240px', minWidth: 0 } }, [
              h('input', {
                key: 'name', style: { ...inputStyle, flex: 1 }, value: newName,
                placeholder: t('folderName'), spellCheck: false, autoFocus: true,
                onChange: event => setNewName(event.target.value),
                onKeyDown: event => { if (event.key === 'Enter') createFolder() },
              }),
              h('button', {
                key: 'go', type: 'button',
                style: buttonStyle('primary', { small: true, disabled: busyCreate || newName.trim() === '' }),
                disabled: busyCreate || newName.trim() === '',
                onClick: createFolder,
              }, busyCreate ? t('creating') : t('create')),
            ])
            : null,
        ]),
      ])
    }

    /** One registered mirror workspace. */
    function WorkspaceCard({ workspace, t, busy, onRemove, onRegister }) {
      const [confirming, setConfirming] = useState(false)
      useEffect(() => {
        if (!confirming) return undefined
        const timer = setTimeout(() => setConfirming(false), 6000)
        return () => clearTimeout(timer)
      }, [confirming])
      const registered = workspace.workspaceId !== null && workspace.workspaceId !== undefined
      const actions = confirming
        ? h('div', { key: 'confirm', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' } }, [
          h('span', { key: 'note', style: { fontSize: 12, color: COLOR.warningText } }, t('deleteWorkspaceNote')),
          h('button', {
            key: 'yes', type: 'button', style: buttonStyle('danger', { small: true }),
            onClick: () => { setConfirming(false); onRemove() },
          }, t('confirmRemove')),
          h('button', { key: 'no', type: 'button', style: buttonStyle('secondary', { small: true }), onClick: () => setConfirming(false) }, t('cancel')),
        ])
        : h('div', { key: 'row', style: { display: 'flex', gap: 6 } }, [
          registered ? null : h('button', {
            key: 'register', type: 'button', style: buttonStyle('secondary', { small: true, disabled: busy }),
            disabled: busy, onClick: onRegister,
          }, t('registerWorkspace')),
          h('button', {
            key: 'remove', type: 'button', style: buttonStyle('danger', { small: true, disabled: busy }),
            disabled: busy, title: t('deleteWorkspaceNote'), onClick: () => setConfirming(true),
          }, t('remove')),
        ])
      return h('div', { style: { ...cardStyle, gap: 8 } }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
        }, [
          h('div', { key: 'title', style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' } }, [
            h('span', { key: 'name', style: { fontSize: 13, fontWeight: 600, color: COLOR.text, wordBreak: 'break-all' } }, workspace.title),
            chip(workspace.machineId),
            registered ? chip(t('workspaceRegistered'), 'success') : chip(t('workspaceUnregistered'), 'warning'),
            h('span', { key: 'current', title: workspace.remotePath }, ''),
          ]),
          actions,
        ]),
        h('div', {
          key: 'meta',
          style: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '3px 12px', alignItems: 'baseline' },
        }, [
          h('span', { key: 'rl', style: { ...hintStyle, whiteSpace: 'nowrap' } }, t('workspace')),
          h('span', { key: 'rv', style: { ...monoStyle, color: COLOR.text } }, workspace.remotePath),
          h('span', { key: 'ml', style: { ...hintStyle, whiteSpace: 'nowrap' } }, t('mirror')),
          h('span', { key: 'mv', style: { ...monoStyle, color: COLOR.tertiary } }, workspace.mirrorPath),
        ]),
      ])
    }

    function SettingsPage(props) {
      const t = props.t ?? (key => key)
      const [data, setData] = useState(undefined)
      const [loadError, setLoadError] = useState(undefined)
      const [statuses, setStatuses] = useState({})
      const [notice, setNotice] = useState(undefined)
      const [pending, setPending] = useState(undefined)
      const [editor, setEditor] = useState(undefined)
      const [browser, setBrowser] = useState(undefined)
      const autoProbed = useRef(false)
      const probeTimers = useRef([])
      const alive = useRef(true)

      const notify = useCallback((kind, text) => {
        if (alive.current) setNotice({ kind, text })
      }, [])

      useEffect(() => {
        if (notice === undefined || notice.kind === 'error') return undefined
        const timer = setTimeout(() => { if (alive.current) setNotice(undefined) }, 5000)
        return () => clearTimeout(timer)
      }, [notice])

      const applyState = useCallback(payload => {
        if (alive.current) setData(payload)
      }, [])

      const load = useCallback(() => {
        callApi('/state', undefined, 10_000)
          .then(payload => { if (alive.current) { applyState(payload); setLoadError(undefined) } })
          .catch(cause => { if (alive.current) setLoadError(cause.message ?? String(cause)) })
      }, [applyState])

      const test = useCallback(machine => {
        setStatuses(current => ({ ...current, [machine.id]: { kind: 'pending' } }))
        callApi('/test', { id: machine.id }, 30_000)
          .then(payload => {
            if (!alive.current) return
            const status = payload.status ?? {}
            setStatuses(current => ({
              ...current,
              [machine.id]: { kind: 'ok', latencyMs: status.latencyMs ?? 0, detail: `${status.user ?? ''}@${status.hostname ?? ''}` },
            }))
          })
          .catch(cause => {
            if (!alive.current) return
            setStatuses(current => ({ ...current, [machine.id]: { kind: 'error', detail: cause.message ?? String(cause) } }))
          })
      }, [])

      const testAll = useCallback(machines => {
        for (const timer of probeTimers.current) clearTimeout(timer)
        probeTimers.current = machines.map((machine, index) => setTimeout(() => {
          if (alive.current) test(machine)
        }, index * 200))
      }, [test])

      useEffect(() => () => {
        for (const timer of probeTimers.current) clearTimeout(timer)
        probeTimers.current = []
      }, [])

      useEffect(() => {
        alive.current = true
        load()
        return () => { alive.current = false }
      }, [load])

      useEffect(() => {
        if (data === undefined || autoProbed.current) return
        autoProbed.current = true
        testAll(data.machines)
      }, [data, testAll])

      const removeMachine = async machine => {
        if (pending !== undefined) return
        setPending(`machine:${machine.id}`)
        try {
          const payload = await callApi('/machines', { action: 'remove', id: machine.id })
          applyState(payload)
          notify('success', `${t('removed')}: ${machine.id}`)
        } catch (cause) {
          notify('error', friendlyError(t, cause))
        } finally {
          setPending(undefined)
        }
      }

      /** Choose a machine's remote directory; resolves true when the workspace was registered. */
      const chooseWorkspace = async (machine, path) => {
        if (pending !== undefined) return false
        setPending('workspace')
        try {
          const payload = await callApi('/workspace', { id: machine.id, workspace: path }, 60_000)
          applyState(payload)
          const workspace = payload.workspace
          notify('success', workspace === undefined || workspace === null
            ? `${t('saved')}: ${machine.id} → ${path}`
            : `${t('workspaceCreated')}: ${workspace.title}`)
          return true
        } catch (cause) {
          notify('error', friendlyError(t, cause))
          return false
        } finally {
          setPending(undefined)
        }
      }

      const removeWorkspace = async workspace => {
        if (pending !== undefined) return
        setPending(`workspace:${workspace.id}`)
        try {
          const payload = await callApi('/workspaces/remove', { id: workspace.id })
          applyState(payload)
          notify('success', `${t('removed')}: ${workspace.title}`)
        } catch (cause) {
          notify('error', friendlyError(t, cause))
        } finally {
          setPending(undefined)
        }
      }

      const registerWorkspace = async workspace => {
        if (pending !== undefined) return
        setPending(`workspace:${workspace.id}`)
        try {
          const payload = await callApi('/workspaces/register', { id: workspace.id }, 60_000)
          applyState(payload)
          notify('success', t('registeredNotice'))
        } catch (cause) {
          notify('error', friendlyError(t, cause))
        } finally {
          setPending(undefined)
        }
      }

      const savedMachine = payload => {
        applyState(payload)
        setEditor(undefined)
        const name = payload.machine?.id ?? ''
        const workspace = payload.workspace
        notify('success', workspace === undefined || workspace === null
          ? `${t('saved')}: ${name}`
          : `${t('saved')}: ${name} · ${t('workspaceCreated')} ${workspace.title}`)
        const machine = (payload.machines ?? []).find(entry => entry.id === name)
        if (machine !== undefined) test(machine)
      }

      const machines = data?.machines ?? []
      const workspaces = data?.workspaces ?? []
      const headerBusy = data === undefined && loadError === undefined

      return h('div', { style: { padding: '22px 26px 30px', maxWidth: 940, color: COLOR.text, font: 'inherit' } }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' },
        }, [
          h('div', { key: 'text', style: { minWidth: 260, flex: '1 1 320px' } }, [
            h('h2', { key: 'title', style: { margin: 0, fontSize: 18, fontWeight: 600, color: COLOR.text } }, t('title')),
            h('p', { key: 'sub', style: { ...hintStyle, margin: '6px 0 0' } }, t('subtitle')),
          ]),
          h('div', { key: 'actions', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
            h('button', {
              key: 'refresh', type: 'button',
              style: buttonStyle('secondary'), title: t('refreshTitle'), disabled: headerBusy,
              onClick: () => { load(); setNotice(undefined) },
            }, t('refresh')),
            h('button', {
              key: 'testAll', type: 'button',
              style: buttonStyle('secondary', { disabled: headerBusy || machines.length === 0 }), title: t('probeAllTitle'),
              disabled: headerBusy || machines.length === 0,
              onClick: () => testAll(machines),
            }, t('testAll')),
            h('button', { key: 'add', type: 'button', style: buttonStyle('primary'), onClick: () => setEditor({ mode: 'create' }) }, t('add')),
          ]),
        ]),
        notice === undefined ? null : h('div', {
          key: 'notice',
          role: 'status',
          'aria-live': 'polite',
          style: {
            marginTop: 12,
            padding: '9px 12px',
            borderRadius: 8,
            fontSize: 12,
            border: `1px solid ${notice.kind === 'error' ? COLOR.error : COLOR.success}`,
            color: notice.kind === 'error' ? COLOR.error : COLOR.text,
            background: COLOR.layer2,
            wordBreak: 'break-word',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          },
        }, [
          h('span', { key: 'text', style: { flex: 1 } }, notice.text),
          h('button', {
            key: 'dismiss',
            type: 'button',
            'aria-label': t('dismiss'),
            style: { ...buttonStyle('secondary', { small: true, disabled: false }), border: 'none', padding: '2px 6px', color: COLOR.secondary },
            onClick: () => setNotice(undefined),
          }, '×'),
        ]),
        data === undefined && loadError === undefined ? h('div', { key: 'loading', style: { marginTop: 18 } }, h(Spinner, { t })) : null,
        loadError !== undefined ? h('div', { key: 'loadError', style: { marginTop: 18, padding: '10px 12px', borderRadius: 8, border: `1px solid ${COLOR.error}` } }, [
          h('div', { key: 'text', style: { fontSize: 12, color: COLOR.error } }, `${t('loadFailed')}: ${loadError}`),
          h('button', { key: 'retry', type: 'button', style: { ...buttonStyle('secondary', { small: true }), marginTop: 8 }, onClick: () => { setLoadError(undefined); load() } }, t('retry')),
        ]) : null,
        data === undefined ? null : h('div', { key: 'content' }, [
          h(Section, {
            key: 'machines',
            title: t('machinesTitle'),
            hint: t('machinesHint'),
            t,
          }, machines.length === 0
            ? h('div', {
              key: 'empty',
              style: { ...hintStyle, border: `1px dashed ${COLOR.borderStrong}`, borderRadius: 12, padding: '18px 16px' },
            }, [
              h('div', { key: 'title', style: { fontSize: 13, fontWeight: 600, color: COLOR.text, marginBottom: 4 } }, t('empty')),
              h('div', { key: 'hint', style: { marginBottom: 10 } }, t('emptyHint')),
              h('button', { key: 'add', type: 'button', style: buttonStyle('primary'), onClick: () => setEditor({ mode: 'create' }) }, t('add')),
            ])
            : machines.map(machine => h(MachineCard, {
              key: machine.id,
              machine,
              t,
              busy: pending !== undefined,
              canRemove: machines.length > 1,
              status: statuses[machine.id],
              onTest: () => test(machine),
              onBrowse: () => setBrowser({
                target: { id: machine.id, host: machine.host, workspace: machine.workspace, label: machine.id },
                onPick: path => chooseWorkspace(machine, path),
              }),
              onEdit: () => setEditor({ mode: 'edit', machine }),
              onRemove: () => removeMachine(machine),
            }))),
          h(Section, {
            key: 'workspaces',
            title: t('workspacesTitle'),
            hint: t('workspacesHint'),
            t,
          }, workspaces.length === 0
            ? h('div', {
              key: 'empty',
              style: { ...hintStyle, border: `1px dashed ${COLOR.borderStrong}`, borderRadius: 12, padding: '16px', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' },
            }, [
              h('span', { key: 'text' }, t('emptyWorkspaces')),
              h('button', {
                key: 'cta',
                type: 'button',
                style: buttonStyle('secondary', { small: true }),
                onClick: () => setEditor({ mode: 'create' }),
              }, t('add')),
            ])
            : workspaces.map(workspace => h(WorkspaceCard, {
              key: workspace.id,
              workspace,
              t,
              busy: pending !== undefined,
              onRemove: () => removeWorkspace(workspace),
              onRegister: () => registerWorkspace(workspace),
            }))),
          h('div', { key: 'footer', style: { marginTop: 22, display: 'flex', flexDirection: 'column', gap: 5 } }, [
            h('div', { key: 'tools', style: hintStyle }, t('toolsHint')),
            h('div', { key: 'picker', style: hintStyle }, t('localPickerNote')),
            data.stateFile === null || data.stateFile === undefined
              ? null
              : h('div', { key: 'file', style: { ...hintStyle, ...monoStyle } }, `${t('stateFile')} ${data.stateFile}`),
          ]),
        ]),
        editor === undefined ? null : h(MachineModal, {
          key: 'editor',
          mode: editor.mode,
          machine: editor.machine,
          t,
          onClose: () => setEditor(undefined),
          onSaved: savedMachine,
          onBrowse: (draft, pick) => setBrowser({
            target: { id: draft.id, host: draft.host, workspace: draft.workspace, label: draft.id || draft.host },
            onPick: path => pick(path),
          }),
        }),
        browser === undefined ? null : h(BrowserModal, {
          key: 'browser',
          target: browser.target,
          level: 1100,
          t,
          busy: pending !== undefined,
          onClose: () => { if (pending === undefined) setBrowser(undefined) },
          onPick: async path => {
            const outcome = await browser.onPick(path)
            if (outcome !== false) setBrowser(undefined)
          },
        }),
      ])
    }

    return {
      inject: ['slots', 'locale'],
      // Exposed for the offline client contract test (`scripts/client-selftest.mjs`).
      __components: { SettingsPage, MachineCard, MachineModal, BrowserModal, WorkspaceCard, Modal, StatusPill },
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'ssh-remote: dictionaries')
        } catch (error) {
          // A duplicate registration after a hot reload must not remove the panel.
          try { console.warn?.('[ssh-remote] locale registration skipped', error) } catch { /* ignore */ }
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'ssh-remote',
          order: 36,
          label: () => t('title'),
          locale: NS,
        }, props => h(SettingsPage, { ...props, t })))
      },
    }
  },
})
