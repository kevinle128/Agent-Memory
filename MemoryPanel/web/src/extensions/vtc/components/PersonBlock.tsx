import { useTranslation } from 'react-i18next';
import { formatSaigon, type PendingItem } from '../logic';

/** Who the dialog is about: mail on top, VTC user ID, first login and source below. */
export function PersonBlock({ item }: { item: PendingItem }) {
  const { t } = useTranslation('ext-vtc');
  return (
    <div>
      <b>{item.email}</b>
      <div className="_memory-field-hint">
        {t('person.detail', {
          vtcId: item.vtc_user_id,
          time: formatSaigon(item.first_login_at),
          source: t(`source.${item.source}`),
        })}
      </div>
    </div>
  );
}
