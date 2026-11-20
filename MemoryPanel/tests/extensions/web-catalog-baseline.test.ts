import { createElement } from '../../web/node_modules/react';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server';
import { describe, expect, it } from 'vitest';
import baseline from './fixtures/web-catalog-baseline.json';

const { usePageMeta, GROUP_ORDER_KEYS } = await import('../../web/src/constants/menu');

type Meta = ReturnType<typeof usePageMeta>;

// Without an i18next instance the hook returns keys, which is enough to read ids and groups.
function readPageMeta(): Meta {
  let meta: Meta | undefined;
  const Probe = () => {
    meta = usePageMeta();
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  if (!meta) throw new Error('usePageMeta did not run');
  return meta;
}

const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);

describe('web page catalog with no extension', () => {
  it('matches the recorded core pages', () => {
    const actual = Object.values(readPageMeta())
      .map((m) => ({
        id: m.id,
        group: m.group.replace('menu.group.', ''),
        order: m.order,
        ...(m.affix === undefined ? {} : { affix: m.affix }),
      }))
      .sort(byId);
    const expected = baseline.pages
      .map(({ id, group, order, ...rest }) => ({
        id,
        group,
        order,
        ...('affix' in rest ? { affix: (rest as { affix: boolean }).affix } : {}),
      }))
      .sort(byId);
    expect(actual).toEqual(expected);
  });

  it('matches the recorded group order', () => {
    expect([...GROUP_ORDER_KEYS]).toEqual(baseline.groupOrder);
  });
});
