/**
 * SourceNameField — the source name input. Editable only before the first save, because the
 * name is part of the model id that clients send. Checks the shape while the admin types.
 */
import './style.css';
import { useTranslation } from 'react-i18next';
import { Button, Input } from 'tea-component';
import { validateSourceName } from '@/lib/model-source';

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** True once the source is saved: the field is read only. */
  saved: boolean;
  /** Read-only view for people who cannot edit. */
  readOnly?: boolean;
  /** Source names held by other groups. */
  taken: ReadonlySet<string>;
  /** Name the system proposed, for the reset button. */
  suggestion: string;
  /** Bare id of a model, for the example line. */
  exampleModel: string;
}

export function SourceNameField({ value, onChange, saved, readOnly, taken, suggestion, exampleModel }: Props) {
  const { t } = useTranslation();
  const example = `${value || '…'}/${exampleModel || 'model'}`;

  if (saved || readOnly) {
    return (
      <div>
        <Input value={value} readonly size="m" className="_memory-ms-mono" />
        {saved && <div className="_memory-ms-help">{t('modelSource.name.locked')}</div>}
        <div className="_memory-ms-help">
          {t('modelSource.name.example')} <code>{example}</code>
        </div>
      </div>
    );
  }

  const problem = validateSourceName(value, taken);
  const touched = value !== suggestion;
  return (
    <div>
      <div className="_memory-ms-row">
        <Input
          value={value}
          onChange={(v) => onChange(v)}
          size="m"
          className={`_memory-ms-mono${problem ? ' _memory-ms-input-error' : ''}`}
          autoComplete="off"
        />
        <Button type="weak" disabled={!touched} onClick={() => onChange(suggestion)}>
          {t('modelSource.name.useSuggested')}
        </Button>
      </div>
      <div className={problem ? '_memory-ms-msg _memory-ms-msg--err' : '_memory-ms-msg _memory-ms-msg--ok'}>
        {problem ? t(`modelSource.name.problem.${problem}`) : t(touched ? 'modelSource.name.valid' : 'modelSource.name.suggested')}
      </div>
      <div className="_memory-ms-help">
        {t('modelSource.name.help')} <b>{t('modelSource.name.immutable')}</b> {t('modelSource.name.example')} <code>{example}</code>
      </div>
    </div>
  );
}
