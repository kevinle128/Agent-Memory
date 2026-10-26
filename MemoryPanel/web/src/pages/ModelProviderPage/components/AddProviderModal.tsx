/**
 * AddProviderModal — creates an API-key model source: provider, base URL, key, formats and the
 * source name. The name is proposed by Core and editable until the first save, because it is part
 * of every model id that clients send. Clients are chosen on the API Key page, not here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox, Input, Modal, Select } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import { modelProvidersApi, type SourceFormat } from '@/lib/api/model-providers';
import {
  PROVIDER_PRESETS,
  SOURCE_FORMATS,
  presetOf,
  toggleInList,
  validateSourceName,
} from '@/lib/model-source';
import { sourceErrorMessage } from '@/lib/source-error';
import { SourceNameField } from '@/components/model-source/SourceNameField';

interface Props {
  /** Source names that other groups and the pools already hold. */
  takenNames: ReadonlySet<string>;
  onClose: () => void;
  /** Called after the source is created and the first model read ran. */
  onCreated: (sourceName: string) => Promise<void>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div className="_memory-mp-label">{label}</div>
      <div className="_memory-mp-ctrl">{children}</div>
    </>
  );
}

export function AddProviderModal({ takenNames, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const first = PROVIDER_PRESETS[0]!;
  const [slug, setSlug] = useState(first.slug);
  const [baseUrl, setBaseUrl] = useState(first.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [formats, setFormats] = useState<SourceFormat[]>([first.format]);
  const [sourceName, setSourceName] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const [saving, setSaving] = useState(false);
  const suggestionRef = useRef('');

  // Propose a source name for the provider. An untouched name follows the proposal.
  useEffect(() => {
    let live = true;
    modelProvidersApi.suggestSourceName('api', slug).then(
      (name) => {
        if (!live) return;
        // Read the old proposal now: the state updater below runs later, after the ref changes.
        const previous = suggestionRef.current;
        suggestionRef.current = name;
        setSuggestion(name);
        setSourceName((cur) => (cur === '' || cur === previous ? name : cur));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [slug]);

  function onProviderChange(next: string) {
    const preset = presetOf(next);
    setSlug(next);
    setBaseUrl(preset.baseUrl);
    setFormats([preset.format]);
  }

  const problem = useMemo(() => validateSourceName(sourceName, takenNames), [sourceName, takenNames]);
  const missing = !baseUrl.trim() || !apiKey.trim() || formats.length === 0 || problem !== null;

  async function save() {
    if (missing || saving) return;
    setSaving(true);
    try {
      const group = await modelProvidersApi.create({
        // The group needs its own unique name; the source name is unique by construction.
        name: sourceName,
        agents: [],
        mode: 'custom_unified',
        base_url: baseUrl.trim(),
        api_key: apiKey.trim(),
        source_name: sourceName,
        source_provider: slug,
        source_formats: formats,
        source_enabled: true,
      });
      // First read of the model list. A failed read is stored on the group, not thrown.
      await modelProvidersApi.refresh(group.group_id).catch(() => undefined);
      tea.notify.success(t('modelProvider.toast.created', { name: sourceName }));
      await onCreated(sourceName);
    } catch (e) {
      const message = sourceErrorMessage(e);
      if (message) tea.notify.error(message);
      else tea.notify.error(e);
      setSaving(false);
    }
  }

  return (
    <Modal visible size="l" caption={t('modelProvider.add')} onClose={onClose} disableEscape={saving}>
      <Modal.Body>
        <div className="_memory-mp-form">
          <Row label={t('modelProvider.form.provider')}>
            <Select
              appearance="button"
              size="m"
              value={slug}
              onChange={onProviderChange}
              options={PROVIDER_PRESETS.map((p) => ({ value: p.slug, text: p.label || t('modelProvider.provider.other') }))}
            />
          </Row>
          <Row label={t('modelProvider.form.baseUrl')}>
            <Input
              value={baseUrl}
              onChange={setBaseUrl}
              size="l"
              placeholder="https://example-provider.internal/v1"
              className="_memory-ms-mono"
            />
          </Row>
          <Row label={t('modelProvider.form.apiKey')}>
            <Input.Password value={apiKey} onChange={setApiKey} size="l" autoComplete="off" placeholder="sk-••••" />
            <div className="_memory-ms-help">{t('modelProvider.form.keyHelp')}</div>
          </Row>
          <Row label={t('modelProvider.form.formats')}>
            <div className="_memory-mp-tags" style={{ gap: 16 }}>
              {SOURCE_FORMATS.map((f) => (
                <Checkbox key={f} value={formats.includes(f)} onChange={(v) => setFormats(toggleInList(formats, f, v) as SourceFormat[])}>
                  {t(`modelSource.format.${f}`)}
                </Checkbox>
              ))}
            </div>
            <div className="_memory-ms-help">{t('modelProvider.form.formatsHelp')}</div>
          </Row>
          <Row label={t('modelProvider.form.sourceName')}>
            <SourceNameField
              value={sourceName}
              onChange={setSourceName}
              saved={false}
              taken={takenNames}
              suggestion={suggestion}
              exampleModel=""
            />
          </Row>
        </div>
        <div className="_memory-ms-help" style={{ marginTop: 12 }}>{t('modelProvider.add.afterSave')}</div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" loading={saving} disabled={missing || saving} onClick={() => void save()}>
          {t('modelProvider.save')}
        </Button>
        <Button disabled={saving} onClick={onClose}>{t('modelProvider.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
