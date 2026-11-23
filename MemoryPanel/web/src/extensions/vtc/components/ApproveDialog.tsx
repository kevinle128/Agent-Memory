import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, Modal, Radio, Select, Tag } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { usersApi } from '@/lib/api/users';
import { membersApi, teamsApi } from '@/lib/api/teams';
import { tea } from '@/lib/tea-bridge';
import { isGlobalAdmin } from '@/services/permissions';
import { useAuthStore } from '@/stores/auth';
import { invalidateBackendCache, readActiveTeamId } from '@/services';
import { PENDING_CHANGED_EVENT, candidatesFromConflict, vtcApi } from '../api';
import {
  approveBody,
  canSubmit,
  defaultAccountChoice,
  unselectableReason,
  type AccountChoice,
  type Candidate,
  type PendingItem,
  type TeamRoleChoice,
} from '../logic';
import { PersonBlock } from './PersonBlock';
import { isStaleRequestError, knownErrorText, reportError } from './report-error';

const CREATE_TEAM = '__create_team__';

export default function ApproveDialog({ item, onClose, onDone }: { item: PendingItem; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation('ext-vtc');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [choice, setChoice] = useState<AccountChoice>(
    item.kind === 'no_team' ? { mode: 'existing' } : { mode: 'create', confirmed: false },
  );
  const [lookupDone, setLookupDone] = useState(item.kind === 'no_team');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [teams, setTeams] = useState<Array<{ team_id: string; name: string }> | null>(null);
  const { auth } = useAuthStore();
  const canCreateTeam = !!auth && isGlobalAdmin(auth.user, auth.isAdmin);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [role, setRole] = useState<TeamRoleChoice>('member');
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [teamBusy, setTeamBusy] = useState(false);

  const [searching, setSearching] = useState(false);
  const [searchName, setSearchName] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  // A submit error describes the old choice; drop it once the admin changes the account, team or role.
  useEffect(() => {
    setSubmitError(null);
  }, [choice, teamId, role]);

  useEffect(() => {
    let alive = true;
    vtcApi
      .teams()
      .then((result) => {
        if (!alive) return;
        setTeams(result.teams);
        // Preselect the team shown in the header when the admin belongs to it, so the usual case is one click.
        const active = readActiveTeamId();
        if (active && result.teams.some((team) => team.team_id === active)) setTeamId(active);
      })
      .catch((err) => {
        if (!alive) return;
        setTeams([]);
        setLoadError(t('page.loadFailed'));
        tea.notify.error(err);
      });
    if (item.kind === 'new') {
      vtcApi
        .candidates(item.pending_id)
        .then((result) => {
          if (!alive) return;
          setCandidates(result.candidates);
          setChoice(defaultAccountChoice(item, result.candidates));
          setLookupDone(true);
        })
        .catch((err) => {
          if (!alive) return;
          setLoadError(t('page.loadFailed'));
          reportError(t, err);
        });
    }
    return () => {
      alive = false;
    };
  }, [item, t]);

  const ready = lookupDone && teams !== null && !loadError;
  const submittable = ready && !creatingTeam && canSubmit(item, candidates, choice, teamId);
  const hasCandidates = candidates.length > 0;
  const teamOptions = useMemo(
    () => [
      ...(teams ?? []).map((team) => ({ value: team.team_id, text: team.name })),
      ...(canCreateTeam ? [{ value: CREATE_TEAM, text: t('approve.team.create') }] : []),
    ],
    [teams, t, canCreateTeam],
  );

  async function createTeam() {
    const name = newTeamName.trim();
    if (!name) return;
    setTeamBusy(true);
    try {
      const created = await teamsApi.create({ name });
      invalidateBackendCache();
      setTeams((current) => [...(current ?? []), created]);
      setTeamId(created.team_id);
      setCreatingTeam(false);
      setNewTeamName('');
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setTeamBusy(false);
    }
  }

  async function findByUsername() {
    const username = searchName.trim();
    if (!username) return;
    setSearchBusy(true);
    try {
      const found = await usersApi.list({ username });
      // A team admin may only be shown people who already belong to a team they administer.
      // The approve route still refuses anyone else.
      let visible = found;
      if (!canCreateTeam) {
        const allowed = new Set<string>();
        for (const team of teams ?? []) {
          for (const member of await membersApi.list(team.team_id)) {
            if (member.status === 'active') allowed.add(member.user_id);
          }
        }
        visible = found.filter((user) => allowed.has(user.user_id));
      }
      if (visible.length === 0) {
        tea.notify.warning(t('approve.search.none'));
        return;
      }
      // The server checks again that the account may be linked; this only fills the list.
      const extra: Candidate[] = visible.map((user) => ({
        user_id: user.user_id,
        username: user.username,
        display_name: user.display_name ?? null,
        email: user.email ?? null,
        auth_provider: user.auth_provider,
        user_type: user.user_type ?? 'normal',
        // Found by the administrator's search, not by matching the person's email.
        match: [],
      }));
      const merged = [...candidates, ...extra.filter((c) => !candidates.some((known) => known.user_id === c.user_id))];
      setCandidates(merged);
      // A user already in the list keeps its own details (such as an existing VTC link) when picked.
      const pick = extra
        .map((c) => merged.find((known) => known.user_id === c.user_id) ?? c)
        .find((c) => unselectableReason(c) === null);
      if (pick) setChoice({ mode: 'link', userId: pick.user_id });
      setSearchName('');
      setSearching(false);
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setSearchBusy(false);
    }
  }

  async function submit() {
    if (!teamId || !submittable) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await vtcApi.approve(approveBody(item, candidates, choice, teamId, role));
      invalidateBackendCache();
      tea.notify.success(t('approve.done', { name: result.username }));
      if (result.role_kept) tea.notify.warning(t('approve.roleKept', { name: result.username, role: t(`approve.role.label.${result.role}`, { defaultValue: result.role }) }));
      if (result.warnings.includes('default_agent_missing')) tea.notify.warning(t('approve.noAgent'));
      window.dispatchEvent(new CustomEvent(PENDING_CHANGED_EVENT));
      onDone();
    } catch (err) {
      const fresh = candidatesFromConflict(err);
      if (fresh) {
        // Another account that may be the same person appeared; the admin decides again with the new list.
        setCandidates(fresh);
        setChoice(defaultAccountChoice(item, fresh));
        setNotice(t('approve.newCandidates'));
      } else if (isStaleRequestError(err)) {
        // The dialog closes, so the notice is the only place left to show the reason.
        reportError(t, err);
        onDone();
      } else {
        // A known code stays inside the dialog so it is read next to the field that caused it.
        const text = knownErrorText(t, err);
        if (text) setSubmitError(text);
        else reportError(t, err);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const guardedClose = () => {
    if (!submitting) onClose();
  };

  const linkValue = choice.mode === 'link' ? choice.userId : '';

  return (
    <Modal visible caption={t('approve.title')} size="m" onClose={guardedClose} disableEscape={submitting}>
      <Modal.Body>
        {loadError && <Alert type="error">{loadError}</Alert>}
        {notice && <Alert type="warning">{notice}</Alert>}
        {submitError && <Alert type="error">{submitError}</Alert>}
        <Form>
          <Form.Item label={t('person.label')}>
            <PersonBlock item={item} />
          </Form.Item>

          <Form.Item label={t('approve.account')}>
            {item.kind === 'no_team' ? (
              <div>{t('approve.existingUser', { name: item.core_username ?? item.core_user_id ?? '' })}</div>
            ) : !lookupDone ? (
              <div className="_memory-field-hint">{t('approve.checking')}</div>
            ) : (
              <div>
                {hasCandidates ? (
                  <>
                    <div className="_memory-field-hint" style={{ marginBottom: 8 }}>{t('approve.candidatesHint')}</div>
                    <Radio.Group
                      value={choice.mode === 'link' ? 'link' : 'create'}
                      onChange={(value) => {
                        if (value === 'create') {
                          setChoice({ mode: 'create', confirmed: false });
                        } else {
                          const first = candidates.find((c) => unselectableReason(c) === null);
                          if (first) setChoice({ mode: 'link', userId: first.user_id });
                        }
                      }}
                    >
                      <Radio name="link" disabled={!candidates.some((c) => unselectableReason(c) === null)}>
                        {t('approve.linkExisting')}
                      </Radio>
                      <Radio name="create">{t('approve.createNew')}</Radio>
                    </Radio.Group>
                    <div style={{ margin: '8px 0 0 24px' }}>
                        <Radio.Group value={linkValue} onChange={(value) => setChoice({ mode: 'link', userId: value })}>
                          {candidates.map((c) => {
                            const reason = unselectableReason(c);
                            return (
                              <Radio key={c.user_id} name={c.user_id} disabled={reason !== null} style={{ display: 'block', marginBottom: 6 }}>
                                <b>{c.username}</b>
                                {c.display_name ? ` · ${c.display_name}` : ''}
                                {c.email ? ` · ${c.email}` : ''}{' '}
                                <Tag size="sm">{c.user_type}</Tag>
                                {c.match.includes('email') && <Tag size="sm" theme="success">{t('approve.matchEmail')}</Tag>}
                                {c.match.includes('username') && <Tag size="sm" theme="success">{t('approve.matchUsername')}</Tag>}
                                {reason === 'linked' && <div className="_memory-field-hint">{t('approve.linkedElsewhere')}</div>}
                                {reason === 'system_admin' && <div className="_memory-field-hint">{t('approve.systemAdmin')}</div>}
                              </Radio>
                            );
                          })}
                        </Radio.Group>
                    </div>
                    {choice.mode === 'create' && (
                      <div style={{ margin: '8px 0 0 24px' }}>
                        <Checkbox value={choice.confirmed} onChange={(confirmed) => setChoice({ mode: 'create', confirmed })}>
                          {t('approve.confirmCreate')}
                        </Checkbox>
                      </div>
                    )}
                  </>
                ) : (
                  <div>{t('approve.newUser')}</div>
                )}
                {/* Shown even with candidates: the person's real account may have another name. */}
                <div style={{ marginTop: 8 }}>
                  {searching ? (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Input
                        autoFocus
                        value={searchName}
                        onChange={setSearchName}
                        onPressEnter={() => void findByUsername()}
                        placeholder={t('approve.search.placeholder')}
                      />
                      <Button type="primary" onClick={() => void findByUsername()} disabled={!searchName.trim() || searchBusy} loading={searchBusy}>
                        {t('approve.search.button')}
                      </Button>
                      <Button onClick={() => setSearching(false)} disabled={searchBusy}>
                        {t('approve.search.cancel')}
                      </Button>
                    </div>
                  ) : (
                    <Button type="link" onClick={() => setSearching(true)}>
                      {t('approve.linkInstead')}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </Form.Item>

          <Form.Item label={t('approve.team')} required>
            <div>
              <Select
                size="full"
                matchButtonWidth
                value={creatingTeam ? CREATE_TEAM : (teamId ?? '')}
                placeholder={t('approve.team.placeholder')}
                options={teamOptions}
                onChange={(value) => {
                  if (value === CREATE_TEAM) setCreatingTeam(true);
                  else {
                    setCreatingTeam(false);
                    setTeamId(value);
                  }
                }}
              />
              {teams !== null && teams.length === 0 && !creatingTeam && (
                <div className="_memory-field-hint">{t('approve.team.empty')}</div>
              )}
              {canCreateTeam && creatingTeam && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <Input
                    autoFocus
                    value={newTeamName}
                    onChange={setNewTeamName}
                    onPressEnter={() => void createTeam()}
                    placeholder={t('approve.team.name')}
                  />
                  <Button type="primary" onClick={() => void createTeam()} disabled={!newTeamName.trim() || teamBusy} loading={teamBusy}>
                    {t('approve.team.createButton')}
                  </Button>
                </div>
              )}
            </div>
          </Form.Item>

          <Form.Item label={t('approve.role')}>
            <div>
              <Select
                size="full"
                matchButtonWidth
                value={role}
                onChange={(value) => setRole(value as TeamRoleChoice)}
                options={[
                  { value: 'member', text: t('approve.role.member') },
                  { value: 'admin', text: t('approve.role.admin') },
                ]}
              />
              <div className="_memory-field-hint">{t('approve.role.hint')}</div>
            </div>
          </Form.Item>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={!submittable || submitting} loading={submitting}>
          {t('approve.submit')}
        </Button>
        <Button onClick={guardedClose} disabled={submitting}>
          {t('approve.cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
