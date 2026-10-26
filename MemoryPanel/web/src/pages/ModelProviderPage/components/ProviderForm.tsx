/**
 * ProviderForm — create, edit or view one custom group. Three parts: the group itself, the old
 * "use for whole agents" path and the new "use as a source" path. Model ticks are written at once
 * through their own action; everything else is written by the save button as a patch of changes.
 * The stored key is never shown, and an empty key box is never sent.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Checkbox, Input, Radio, Select, Switch, Tag } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import {
  modelProvidersApi,
  type GroupMode,
  type ProviderGroup,
  type SourceFormat,
  type SupportedAgent,
  type WrittenGroup,
} from '@/lib/api/model-providers';
import {
  PROVIDER_PRESETS,
  SOURCE_FORMATS,
  buildUpdate,
  countEnabled,
  draftOf,
  draftProblems,
  emptyDraft,
  formatFetchedAt,
  hasChanges,
  multiSourceAgents,
  presetGroupName,
  presetOf,
  sourceInputOf,
  toggleInList,
  type GroupDraft,
} from '@/lib/model-source';
import { sourceErrorMessage } from '@/lib/source-error';
import { SourceNameField } from '@/components/model-source/SourceNameField';
import { SourceAgentsTable } from '@/components/model-source/SourceAgentsTable';
import { SourceModelTable, type ModelChange } from '@/components/model-source/SourceModelTable';

interface Props {
  mode: 'add' | 'edit';
  group: ProviderGroup | null;
  /** Opened from "use as a source" on a group that is not a source yet. */
  attach: boolean;
  readOnly: boolean;
  groups: readonly ProviderGroup[];
  /** Agents that sit in a subscription pool now. */
  poolAgents: ReadonlySet<string>;
  /** Source names held by other groups and by pools. */
  takenNames: ReadonlySet<string>;
  onBack: () => void;
  /** The group was saved. `created` is true for a new group. */
  onSaved: (groupId: string, created: boolean) => void;
  /** A model write changed the stored group; the list and preview reload. */
  onChanged: () => void;
}

function Row({ label, children, isNew }: { label: ReactNode; children: ReactNode; isNew?: boolean }) {
  return (
    <>
      <div className="_memory-mp-label">{label}</div>
      <div className={`_memory-mp-ctrl${isNew ? ' _memory-mp-ctrl--new' : ''}`}>{children}</div>
    </>
  );
}

function Section({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="_memory-mp-section">
      <b>{title}</b>
      {sub && <span>{sub}</span>}
    </div>
  );
}

export function ProviderForm({ mode, group, attach, readOnly, groups, poolAgents, takenNames, onBack, onSaved, onChanged }: Props) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<ProviderGroup | null>(group);
  const savedSource = Boolean(current?.source_name);
  const [suggestion, setSuggestion] = useState('');
  // Last proposal, to tell an untouched name from one the admin typed.
  const suggestionRef = useRef('');
  const [draft, setDraft] = useState<GroupDraft>(() => {
    const d = group ? draftOf(group, '') : emptyDraft('');
    if (attach) d.useSource = true;
    return d;
  });
  const [supported, setSupported] = useState<SupportedAgent[]>([]);
  const [saving, setSaving] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const patchDraft = (p: Partial<GroupDraft>) => setDraft((d) => ({ ...d, ...p }));

  useEffect(() => {
    if (readOnly) return;
    let live = true;
    modelProvidersApi.supportedAgents().then(
      (items) => live && setSupported(items),
      (e) => live && tea.notify.error(e),
    );
    return () => {
      live = false;
    };
  }, [readOnly]);

  // Propose a source name for the provider. An untouched name follows the proposal.
  useEffect(() => {
    if (readOnly || savedSource) return;
    let live = true;
    modelProvidersApi.suggestSourceName('api', draft.providerSlug).then(
      (name) => {
        if (!live) return;
        // Read the old proposal now: the state updater below runs later, after the ref changes.
        const previous = suggestionRef.current;
        suggestionRef.current = name;
        setSuggestion(name);
        setDraft((d) => (d.sourceName === '' || d.sourceName === previous ? { ...d, sourceName: name } : d));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, savedSource, draft.providerSlug]);

  const unified = draft.mode === 'custom_unified';
  const sourceAllowed = unified;
  const showSource = sourceAllowed && (savedSource || draft.useSource);
  const problems = useMemo(
    () => draftProblems(draft, { original: current, takenNames }),
    [draft, current, takenNames],
  );
  const sourceAgentOptions = multiSourceAgents(supported).map((a) => ({ id: a.agent_source, label: a.display_name }));
  const agentOptions = supported.map((a) => {
    const owner = groups.find((g) => g.group_id !== current?.group_id && g.agents.includes(a.agent_source));
    const inPool = poolAgents.has(a.agent_source);
    return { ...a, ownerName: owner?.name ?? null, inPool };
  });

  function fail(e: unknown) {
    const message = sourceErrorMessage(e);
    if (message) tea.notify.error(message);
    else tea.notify.error(e);
  }

  function onProviderChange(slug: string) {
    const prev = presetGroupName(draft.providerSlug);
    const preset = presetOf(slug);
    const next: Partial<GroupDraft> = { providerSlug: slug };
    if (mode === 'add') {
      next.baseUrl = preset.baseUrl;
      next.sourceFormats = [preset.format];
    }
    if (!draft.name || draft.name === prev) next.name = presetGroupName(slug);
    patchDraft(next);
  }

  async function save() {
    if (problems.length > 0 || saving) return;
    setSaving(true);
    try {
      if (mode === 'add') {
        const withSource = showSource;
        const created = await modelProvidersApi.create({
          name: draft.name.trim(),
          agents: draft.agents,
          enabled: draft.enabled,
          mode: draft.mode,
          base_url: draft.baseUrl.trim(),
          ...(unified && draft.apiKey.trim() ? { api_key: draft.apiKey.trim() } : {}),
          ...(draft.modelId.trim() ? { model_id: draft.modelId.trim() } : {}),
          ...(draft.description.trim() ? { description: draft.description } : {}),
          ...(withSource ? sourceInputOf(draft, true) : {}),
        });
        // First fetch of the model list. A failed fetch is stored on the group, not thrown.
        if (withSource) await modelProvidersApi.refresh(created.group_id).catch(() => undefined);
        tea.notify.success(t('modelProvider.toast.created', { name: draft.name.trim() }));
        onSaved(created.group_id, true);
      } else if (current) {
        const patch = buildUpdate(current, draft);
        if (!hasChanges(patch)) {
          tea.notify.success(t('modelProvider.toast.nothingToSave'));
          return;
        }
        await modelProvidersApi.update(patch);
        const attached = !current.source_name && Boolean(patch.source_name);
        if (attached) await modelProvidersApi.refresh(current.group_id).catch(() => undefined);
        tea.notify.success(t('modelProvider.toast.saved', { name: draft.name.trim() }));
        onSaved(current.group_id, false);
      }
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }

  function takeWritten(res: WrittenGroup) {
    setCurrent((c) =>
      c
        ? {
            ...c,
            source_models: res.source_models,
            source_models_fetched_at: res.source_models_fetched_at,
            source_models_error: res.source_models_error,
            version: res.version,
          }
        : c,
    );
    onChanged();
  }

  async function writeModels(changes: ModelChange[]) {
    if (!current || changes.length === 0 || modelBusy) return;
    setModelBusy(true);
    try {
      takeWritten(await modelProvidersApi.updateModels(current.group_id, changes));
    } catch (e) {
      fail(e);
    } finally {
      setModelBusy(false);
    }
  }

  async function refreshModels() {
    if (!current) return;
    setRefreshing(true);
    try {
      const res = await modelProvidersApi.refresh(current.group_id);
      takeWritten(res);
      if (res.source_models_error) tea.notify.warning(t('modelProvider.toast.fetchFailed'));
      else tea.notify.success(t('modelProvider.toast.fetched'));
    } catch (e) {
      fail(e);
    } finally {
      setRefreshing(false);
    }
  }

  const models = current?.source_models ?? [];
  const exampleModel = models[0]?.id ?? '';
  const title = readOnly
    ? t('modelProvider.form.viewTitle', { name: draft.name })
    : attach
      ? t('modelProvider.form.attachTitle', { name: draft.name })
      : mode === 'edit'
        ? t('modelProvider.form.editTitle', { name: draft.name })
        : t('modelProvider.form.addTitle');

  return (
    <div className="_memory-mp-formcard">
      <Button type="link" onClick={onBack}>‹ {t('modelProvider.back')}</Button>
      <h3 className="_memory-mp-title">{title}</h3>
      {readOnly && <Alert type="warning">{t('modelProvider.form.readOnly')}</Alert>}

      <div className="_memory-mp-form">
        <Section title={t('modelProvider.form.sectionGroup')} />
        <Row label={t('modelProvider.form.provider')}>
          <Select
            appearance="button"
            size="m"
            disabled={readOnly}
            value={draft.providerSlug}
            onChange={onProviderChange}
            options={PROVIDER_PRESETS.map((p) => ({ value: p.slug, text: p.label || t('modelProvider.provider.other') }))}
          />
        </Row>
        <Row label={<>{t('modelProvider.form.name')} <span className="_memory-mp-req">*</span></>}>
          <Input value={draft.name} disabled={readOnly} onChange={(v) => patchDraft({ name: v })} size="l" />
          <div className="_memory-ms-help">{t('modelProvider.form.nameHelp')}</div>
        </Row>
        <Row label={<>{t('modelProvider.form.mode')} <span className="_memory-mp-req">*</span></>}>
          <Radio.Group
            value={draft.mode}
            disabled={readOnly}
            onChange={(v) => patchDraft({ mode: v as GroupMode })}
          >
            <Radio name="custom_unified" disabled={readOnly}>{t('modelProvider.mode.unified')}</Radio>
            <Radio name="custom_passthrough" disabled={readOnly || savedSource}>
              {t('modelProvider.mode.passthrough')} <Tag theme="warning">{t('modelProvider.source.notAllowed')}</Tag>
            </Radio>
          </Radio.Group>
        </Row>
        <Row label={<>{t('modelProvider.form.baseUrl')} <span className="_memory-mp-req">*</span></>}>
          <Input
            value={draft.baseUrl}
            disabled={readOnly}
            onChange={(v) => patchDraft({ baseUrl: v })}
            size="l"
            placeholder="https://example-provider.internal/v1"
            className="_memory-ms-mono"
          />
        </Row>
        <Row label={t('modelProvider.form.apiKey')}>
          {readOnly ? (
            unified ? (
              <>
                <Tag theme={current?.api_key_configured ? 'success' : 'error'}>
                  {t(current?.api_key_configured ? 'modelProvider.key.configured' : 'modelProvider.key.missing')}
                </Tag>
                <span className="_memory-mp-weak"> {t('modelProvider.form.keyHidden')}</span>
              </>
            ) : (
              <span className="_memory-mp-weak">{t('modelProvider.form.noKey')}</span>
            )
          ) : unified ? (
            <>
              <Input.Password
                value={draft.apiKey}
                onChange={(v) => patchDraft({ apiKey: v })}
                size="l"
                autoComplete="off"
                placeholder={current?.api_key_configured ? t('modelProvider.form.keyKeep') : 'sk-••••'}
              />
              <div className="_memory-ms-help">{t('modelProvider.form.keyHelp')}</div>
            </>
          ) : (
            <Alert type="info">{t('modelProvider.form.passthroughKey')}</Alert>
          )}
        </Row>
        <Row label={t('modelProvider.form.description')}>
          <Input value={draft.description} disabled={readOnly} onChange={(v) => patchDraft({ description: v })} size="l" />
        </Row>

        <Section title={t('modelProvider.form.sectionAgents')} sub={t('modelProvider.form.sectionAgentsSub')} />
        <Row label={t('modelProvider.form.agents')}>
          {readOnly ? (
            draft.agents.length === 0 ? (
              <span className="_memory-mp-weak">—</span>
            ) : (
              <div className="_memory-mp-tags">{draft.agents.map((a) => <Tag key={a} theme="primary">{a}</Tag>)}</div>
            )
          ) : (
            <>
              <div className="_memory-mp-agent-grid">
                {agentOptions.map((a) => {
                  const on = draft.agents.includes(a.agent_source);
                  const locked = !on && (a.inPool || a.ownerName !== null);
                  return (
                    <div key={a.agent_source} className={`_memory-mp-agent${locked ? ' _memory-mp-agent--taken' : ''}`}>
                      <Checkbox
                        value={on}
                        disabled={locked}
                        onChange={(v) => patchDraft({ agents: toggleInList(draft.agents, a.agent_source, v) })}
                      >
                        <b>{a.display_name}</b>
                        {a.multi_source && <Tag theme="primary">multi</Tag>}
                      </Checkbox>
                      {locked && (
                        <div className="_memory-mp-weak">
                          {a.inPool
                            ? t('modelProvider.form.agentInPool')
                            : t('modelProvider.form.agentTaken', { group: a.ownerName })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="_memory-ms-help">{t('modelProvider.form.agentsHelp')}</div>
            </>
          )}
        </Row>
        <Row label={t('modelProvider.form.modelId')}>
          <Input value={draft.modelId} disabled={readOnly} onChange={(v) => patchDraft({ modelId: v })} size="m" className="_memory-ms-mono" />
          <div className="_memory-ms-help">{t('modelProvider.form.modelIdHelp')}</div>
        </Row>
        <Row label={t('modelProvider.form.enabled')}>
          <div className="_memory-mp-switch">
            <Switch value={draft.enabled} disabled={readOnly} onChange={(v) => patchDraft({ enabled: v })} />
            <span>{t(draft.enabled ? 'modelProvider.form.enabledOn' : 'modelProvider.form.enabledOff')}</span>
          </div>
        </Row>

        <Section title={t('modelProvider.form.sectionSource')} sub={t('modelProvider.form.sectionSourceSub')} />
        {!sourceAllowed ? (
          <Row label="" isNew>
            <Alert type="warning">
              <b>{t('modelProvider.source.notAllowed')}.</b> {t('modelProvider.form.passthroughWhy')}
            </Alert>
          </Row>
        ) : (
          <>
            {!savedSource && !readOnly && (
              <Row label={t('modelProvider.form.useSource')} isNew>
                <div className="_memory-mp-switch">
                  <Switch value={draft.useSource} onChange={(v) => patchDraft({ useSource: v })} />
                  <span>{t(draft.useSource ? 'modelProvider.form.useSourceOn' : 'modelProvider.form.useSourceOff')}</span>
                </div>
              </Row>
            )}
            {!savedSource && readOnly && (
              <Row label="" isNew>
                <span className="_memory-mp-weak">{t('modelProvider.source.none')}</span>
              </Row>
            )}
            {showSource && (
              <>
                <Row label={<>{t('modelProvider.form.sourceName')} <span className="_memory-mp-req">*</span></>} isNew>
                  <SourceNameField
                    value={draft.sourceName}
                    onChange={(v) => patchDraft({ sourceName: v })}
                    saved={savedSource}
                    readOnly={readOnly}
                    taken={takenNames}
                    suggestion={suggestion}
                    exampleModel={exampleModel}
                  />
                </Row>
                <Row label={<>{t('modelProvider.form.formats')} <span className="_memory-mp-req">*</span></>} isNew>
                  <div className="_memory-mp-tags" style={{ gap: 16 }}>
                    {SOURCE_FORMATS.map((f: SourceFormat) => (
                      <Checkbox
                        key={f}
                        value={draft.sourceFormats.includes(f)}
                        disabled={readOnly}
                        onChange={(v) => patchDraft({ sourceFormats: toggleInList(draft.sourceFormats, f, v) as SourceFormat[] })}
                      >
                        {t(`modelSource.format.${f}`)}
                      </Checkbox>
                    ))}
                  </div>
                  <div className="_memory-ms-help">{t('modelProvider.form.formatsHelp')}</div>
                </Row>
                <Row label={t('modelProvider.form.sourceAgents')} isNew>
                  <SourceAgentsTable
                    options={readOnly ? draft.sourceAgents.map((id) => ({ id, label: id })) : sourceAgentOptions}
                    selected={draft.sourceAgents}
                    readOnly={readOnly}
                    sourceName={draft.sourceName}
                    enabledModelCount={countEnabled(models)}
                    onToggle={(agent, on) => patchDraft({ sourceAgents: toggleInList(draft.sourceAgents, agent, on) })}
                  />
                </Row>
                <Row label={t('modelProvider.form.models')} isNew>
                  {savedSource && current ? (
                    <>
                      <div className="_memory-mp-tags" style={{ marginBottom: 8 }}>
                        {!readOnly && (
                          <Button type="primary" loading={refreshing} disabled={refreshing} onClick={() => void refreshModels()}>
                            {t(models.length > 0 ? 'modelProvider.form.refresh' : 'modelProvider.form.fetch')}
                          </Button>
                        )}
                        {current.source_models_fetched_at && (
                          <span className="_memory-mp-weak">
                            {t('modelProvider.source.fetchedAt', { time: formatFetchedAt(current.source_models_fetched_at) })}
                          </span>
                        )}
                      </div>
                      {current.source_models_error && (
                        <Alert type="warning" style={{ marginBottom: 8, maxWidth: 760 }}>
                          {t('modelProvider.form.lastError')} {current.source_models_error}
                        </Alert>
                      )}
                      <SourceModelTable
                        models={models}
                        sourceName={current.source_name}
                        kind="checkbox"
                        readOnly={readOnly}
                        busy={modelBusy}
                        showUntickedFilter
                        onChange={(c) => void writeModels(c)}
                      />
                    </>
                  ) : (
                    <div className="_memory-ms-models">
                      <div className="_memory-ms-empty">{t('modelProvider.form.modelsAfterSave')}</div>
                    </div>
                  )}
                </Row>
                <Row label={t('modelProvider.form.sourceEnabled')} isNew>
                  <div className="_memory-mp-switch">
                    <Switch value={draft.sourceEnabled} disabled={readOnly} onChange={(v) => patchDraft({ sourceEnabled: v })} />
                    <span>{t(draft.sourceEnabled ? 'modelProvider.form.sourceEnabledOn' : 'modelProvider.form.sourceEnabledOff')}</span>
                  </div>
                </Row>
              </>
            )}
          </>
        )}
      </div>

      <div className="_memory-mp-footer">
        {readOnly ? (
          <Button onClick={onBack}>{t('modelProvider.form.close')}</Button>
        ) : (
          <>
            <Button type="primary" loading={saving} disabled={saving || problems.length > 0} onClick={() => void save()}>
              {t(mode === 'add' ? 'modelProvider.form.create' : 'modelProvider.form.save')}
            </Button>
            <Button disabled={saving} onClick={onBack}>{t('modelProvider.cancel')}</Button>
            {problems.length > 0 && (
              <span className="_memory-mp-weak">{t(`modelProvider.problem.${problems[0]}`)}</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
