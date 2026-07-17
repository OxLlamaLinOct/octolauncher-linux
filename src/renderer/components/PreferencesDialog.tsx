import { useForm } from 'react-hook-form';
import { useEffect, useState } from 'react';
import {
	FilePen,
	FolderOpen,
	FolderSymlink,
	RefreshCw,
	ScrollText,
	ShieldCheck,
	Gamepad2,
	RotateCcw
} from 'lucide-react';

import { PreferencesSchema } from '~common/schemas';
import { type ProtonStatus as ProtonStatusType } from '~main/types';
import { api } from '~renderer/utils/api';
import zodResolver from '~renderer/utils/zodResolver';
import { useT } from '~renderer/i18n';

import TextButton from './styled/TextButton';
import CheckboxInput from './form/CheckboxInput';
import DialogButton from './styled/DialogButton';
import ClientDirDialog from './ClientDirDialog';
import CloseButton from './styled/CloseButton';

const MirrorStatus = () => {
	const t = useT();
	const [state, setState] = useState<string>('verifying');
	api.updater.observe.useSubscription(undefined, {
		onData: ({ state }) => setState(state)
	});

	if (state === 'serverUnreachable')
		return <span className="s1 text-red">{t('prefs.mirrorOffline')}</span>;
	if (state === 'verifying' || state === 'updating')
		return (
			<span className="s1 text-blueGray">{t('prefs.mirrorChecking')}</span>
		);
	return <span className="s1 text-warmGreen">{t('prefs.mirrorOnline')}</span>;
};

const CompatibilitySection = () => {
	const t = useT();
	const [status, setStatus] = useState<ProtonStatusType>();
	api.proton.observe.useSubscription(undefined, { onData: setStatus });

	const setOverride = api.proton.setOverride.useMutation();
	const resetPrefix = api.proton.resetPrefix.useMutation();
	const openPrefixFolder = api.proton.openPrefixFolder.useMutation();
	const relocatePrefix = api.proton.relocatePrefix.useMutation();
	const filePicker = api.general.filePicker.useMutation();
	const [relocateError, setRelocateError] = useState<string>();

	return (
		<div className="flex min-w-0 flex-col">
			<h4 className="tw-color">{t('prefs.compatibility')}</h4>

			{(!status || status.state === 'searching') && (
				<span className="s1 text-blueGray">{t('prefs.protonSearching')}</span>
			)}
			{status?.state === 'missing' && (
				<span className="s1 text-orange">{t('prefs.protonMissing')}</span>
			)}
			{status?.state === 'ready' && (
				<>
					<select
						className="tw-color mb-1 max-w-[200px] truncate bg-darkGray/40 text-sm"
						value={status.selected.protonPath}
						onChange={e => setOverride.mutate(e.target.value)}
					>
						{status.installs.map(i => (
							<option key={i.protonPath} value={i.protonPath}>
								{i.name}
							</option>
						))}
					</select>
					<TextButton
						icon={Gamepad2}
						onClick={() => openPrefixFolder.mutateAsync()}
						className="!items-start text-left text-blueGray"
					>
						{t('prefs.openPrefixFolder')}
					</TextButton>
					<TextButton
						icon={RotateCcw}
						loading={resetPrefix.isLoading}
						onClick={() => resetPrefix.mutateAsync()}
						className="!items-start text-left text-orange"
					>
						{t('prefs.resetPrefix')}
					</TextButton>
					<TextButton
						icon={FolderSymlink}
						loading={relocatePrefix.isLoading}
						onClick={async () => {
							setRelocateError(undefined);
							const r = await filePicker.mutateAsync({
								properties: ['openDirectory', 'createDirectory']
							});
							if (r.canceled) return;
							try {
								await relocatePrefix.mutateAsync(r.path[0]);
							} catch (e) {
								setRelocateError(
									e instanceof Error ? e.message : JSON.stringify(e)
								);
							}
						}}
						className="!items-start text-left text-blueGray"
					>
						{t('prefs.changePrefixLocation')}
					</TextButton>
					{relocateError && (
						<p className="text-secondary max-w-[200px] text-sm">
							{relocateError}
						</p>
					)}
				</>
			)}
		</div>
	);
};

type Props = { close: () => void };

const PreferencesDialog = ({ close }: Props) => {
	const t = useT();
	const { data: pref } = api.preferences.get.useQuery();
	const setPref = api.preferences.set.useMutation();

	const verify = api.updater.verify.useMutation();
	const repair = api.mods.repair.useMutation();
	const openInstallFolder = api.general.openInstallFolder.useMutation();
	const openLogFile = api.general.openLogFile.useMutation();

	const { handleSubmit, watch, setValue, reset } = useForm({
		defaultValues: pref ?? {},
		resolver: zodResolver(PreferencesSchema)
	});

	useEffect(() => {
		pref && reset(pref);
	}, [reset, pref]);

	const setBool = (key: keyof PreferencesSchema) => (v: boolean) =>
		setValue(key, v, {
			shouldTouch: true,
			shouldDirty: true,
			shouldValidate: true
		});

	return (
		<form
			className="tw-dialog !w-fit min-w-[480px] max-w-[640px] !gap-1"
			onSubmit={handleSubmit(async v => {
				await setPref.mutateAsync({
					cleanWdb: v.cleanWdb,
					minimizeToTrayOnPlay: v.minimizeToTrayOnPlay,
					allowMultipleInstances: v.allowMultipleInstances
				});
				close();
			})}
		>
			<CloseButton
				close={() => {
					reset();
					close();
				}}
			/>
			<h3 className="tw-color">{t('prefs.title')}</h3>
			<hr className="mb-1" />

			<div className="flex items-center gap-3">
				<h4 className="tw-color">{t('prefs.installLocation')}</h4>
				<TextButton
					icon={FolderOpen}
					size={14}
					onClick={() => openInstallFolder.mutateAsync()}
					className="!p-1 text-blueGray"
				>
					{t('prefs.openFolder')}
				</TextButton>
			</div>
			<div className="flex items-center gap-2 border border-blueGray/20 bg-darkGray/40 px-3 py-1">
				<span
					title={pref?.clientDir}
					className="min-w-0 shrink grow overflow-hidden text-ellipsis whitespace-nowrap"
				>
					{pref?.clientDir ?? t('prefs.notSelected')}
				</span>
				<DialogButton
					dialog={closeInner => (
						<ClientDirDialog
							close={() => {
								closeInner();
								close();
							}}
						/>
					)}
				>
					{open => (
						<TextButton
							icon={FilePen}
							size={14}
							onClick={open}
							className="!p-1"
						>
							{t('prefs.change')}
						</TextButton>
					)}
				</DialogButton>
			</div>

			<div className="mt-1 flex items-center gap-3">
				<h4 className="tw-color">{t('prefs.downloadMirror')}</h4>
			</div>
			<div className="flex items-center gap-2 pl-2">
				<input type="radio" checked readOnly className="accent-warmGreen" />
				<span>Iceland</span>
				<MirrorStatus />
				<TextButton
					icon={RefreshCw}
					size={12}
					onClick={() => verify.mutateAsync()}
					title={t('prefs.recheck')}
					className="!p-0 text-blueGray"
				/>
			</div>

			<div className="flex items-start gap-3">
				<div className="flex min-w-0 flex-col">
					<h4 className="tw-color">{t('prefs.troubleshooting')}</h4>
					<TextButton
						icon={ShieldCheck}
						onClick={() => repair.mutateAsync().then(close)}
						className="!items-start text-left text-warmGreen"
					>
						{t('prefs.verifyGameFiles')}
					</TextButton>
					<TextButton
						icon={ScrollText}
						onClick={() => openLogFile.mutateAsync()}
						className="!items-start text-left text-pink"
					>
						{t('prefs.openLogFile')}
					</TextButton>
				</div>

				<div className="flex min-w-0 flex-col">
					<h4 className="tw-color">{t('prefs.generalSettings')}</h4>
					<CheckboxInput
						value={!!watch('cleanWdb')}
						setValue={setBool('cleanWdb')}
						label={t('prefs.cleanWdb')}
					/>
					<CheckboxInput
						value={!!watch('minimizeToTrayOnPlay')}
						setValue={setBool('minimizeToTrayOnPlay')}
						label={t('prefs.minimizeToTray')}
					/>
					<CheckboxInput
						value={!!watch('allowMultipleInstances')}
						setValue={setBool('allowMultipleInstances')}
						label={t('prefs.allowMultipleInstances')}
					/>
				</div>

				<CompatibilitySection />
			</div>

			<TextButton type="submit" className="mt-1 self-end text-green">
				{t('prefs.save')}
			</TextButton>
		</form>
	);
};

export default PreferencesDialog;
