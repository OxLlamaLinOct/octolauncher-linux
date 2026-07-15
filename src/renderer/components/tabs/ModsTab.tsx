import { useEffect, useRef, useState } from 'react';
import { ExternalLink, AlertTriangle, Sparkles } from 'lucide-react';
import { createPortal } from 'react-dom';
import cls from 'classnames';

import { api } from '~renderer/utils/api';
import useScrollHint from '~renderer/utils/useScrollHint';
import { useT } from '~renderer/i18n';
import { type ModRowStatus, type ModsStatus } from '~main/types';

import TextButton from '../styled/TextButton';
import CheckboxInput from '../form/CheckboxInput';
import IconSpinner from '../styled/IconSpinner';

const RowState = ({ row }: { row: ModRowStatus }) => {
	const t = useT();
	if (['downloading', 'installing', 'uninstalling'].includes(row.state))
		return <IconSpinner className="text-blueGray" />;
	if (row.state === 'error')
		return (
			<span title={row.error}>
				<AlertTriangle size={14} className="text-red" />
			</span>
		);
	if (
		row.installedVersion &&
		row.installedVersion !== row.latestVersion &&
		!row.ignoreUpdates
	)
		return <span className="s1 text-pink">{t('mods.update')}</span>;
	return null;
};

const ModRow = ({ row }: { row: ModRowStatus }) => {
	const t = useT();
	const toggle = api.mods.toggle.useMutation();
	const setIgnore = api.mods.setIgnoreUpdates.useMutation();
	const openLink = api.general.openLink.useMutation();

	return (
		<>
			<div className="flex items-baseline gap-2">
				{row.recommended && (
					<Sparkles size={12} className="shrink-0 text-warmGreen" />
				)}
				<span className={cls(row.recommended && 'text-warmGreen')}>
					{row.name}
				</span>
				<span className="s1 text-warmGreen">{row.latestVersion}</span>
			</div>
			<CheckboxInput
				value={row.enabled}
				setValue={v => toggle.mutate({ id: row.id, enabled: v })}
				className="justify-self-center"
			/>
			<div className="flex items-center gap-2">
				<p className="s1 text-blueGray">{row.description}</p>
				<TextButton
					icon={ExternalLink}
					size={14}
					title={row.repoUrl}
					onClick={() => openLink.mutateAsync(row.repoUrl)}
					className="!p-0 text-blueGray"
				/>
				<RowState row={row} />
			</div>
			<CheckboxInput
				value={row.ignoreUpdates}
				setValue={v => setIgnore.mutate({ id: row.id, ignore: v })}
				label={<span className="s1">{t('mods.ignoreUpdates')}</span>}
			/>
		</>
	);
};

const ModsTab = () => {
	const t = useT();
	const [status, setStatus] = useState<ModsStatus>();
	api.mods.observe.useSubscription(undefined, {
		onData: setStatus
	});

	const list = api.mods.list.useQuery(undefined, {
		refetchOnMount: true
	});
	useEffect(() => {
		if (!status && list.data) setStatus(list.data);
	}, [list.data, status]);

	const apply = api.mods.applyAll.useMutation();

	const scrollRef = useScrollHint<HTMLDivElement>();

	const mods = status?.mods ?? [];
	const enabledIds = new Set(mods.filter(m => m.enabled).map(m => m.id));
	const modName = (id: string) => mods.find(m => m.id === id)?.name ?? id;
	const missingDeps = [
		...new Set(
			mods
				.filter(m => m.enabled)
				.flatMap(m => m.requires.filter(d => !enabledIds.has(d)))
		)
	];
	const pendingDepMessage = missingDeps
		.map(dep => {
			const requiredBy = mods
				.filter(m => m.enabled && m.requires.includes(dep))
				.map(m => m.name)
				.join(', ');
			return t('mods.depRequired', { mod: modName(dep), requiredBy });
		})
		.join('\n');

	const dialogRef = useRef<HTMLDialogElement>(null);
	const [shownDepMessage, setShownDepMessage] = useState<string | null>(null);

	useEffect(() => {
		if (shownDepMessage) {
			dialogRef.current?.showModal();
			(document.activeElement as HTMLElement | null)?.blur();
		} else dialogRef.current?.close();
	}, [shownDepMessage]);

	const onApply = () => {
		if (missingDeps.length) {
			setShownDepMessage(pendingDepMessage);
			return;
		}
		apply.mutateAsync();
	};

	const showApply =
		!!status?.dirty || apply.isLoading || status?.state === 'busy';

	return (
		<div className="tw-surface flex min-h-0 flex-grow flex-col gap-3">
			<div className="flex items-baseline justify-between">
				<h4 className="tw-color">{t('mods.title')}</h4>
				{status?.dirty && (
					<span className="s1 text-pink">{t('mods.unsavedChanges')}</span>
				)}
			</div>
			<p className="s1 text-blueGray">
				<span className="text-orange">⚠</span> {t('mods.warning')}
			</p>
			{missingDeps.length > 0 && (
				<p className="s1 text-orange">
					⚠{' '}
					{t('mods.enableRequired', {
						mods: missingDeps.map(modName).join(', ')
					})}
				</p>
			)}
			<hr />
			<div
				ref={scrollRef}
				className="relative -m-4 -mt-0 grid flex-grow grid-cols-[auto_auto_1fr_auto] content-start items-center gap-x-4 gap-y-2 overflow-y-auto p-4 pt-0"
			>
				{status?.mods.map(row => (
					<ModRow key={row.id} row={row} />
				))}
			</div>
			<hr />
			<div className="-mb-4 -mt-3 flex items-center gap-2 py-2">
				<p className="s1 flex-grow text-blueGray">
					<span className="text-warmGreen">{t('mods.highlighted')}</span>{' '}
					{t('mods.highlightedRecommended')}
				</p>
				<TextButton
					type="button"
					loading={apply.isLoading || status?.state === 'busy'}
					onClick={onApply}
					className={cls('text-green', !showApply && 'invisible')}
				>
					{t('mods.apply')}
				</TextButton>
			</div>
			{createPortal(
				<dialog
					ref={dialogRef}
					onClose={() => setShownDepMessage(null)}
					className="h-full w-full items-center justify-center bg-[transparent] backdrop:backdrop-blur-sm [&[open]]:flex"
				>
					{shownDepMessage && (
						<div className="tw-dialog !w-fit min-w-[360px] max-w-[460px] !gap-3">
							<h3 className="tw-color">{t('mods.cantApplyYet')}</h3>
							<p className="s1 whitespace-pre-line">{shownDepMessage}</p>
							<TextButton
								onClick={() => setShownDepMessage(null)}
								className="self-end text-green"
							>
								{t('mods.close')}
							</TextButton>
						</div>
					)}
				</dialog>,
				document.body
			)}
		</div>
	);
};

export default ModsTab;
