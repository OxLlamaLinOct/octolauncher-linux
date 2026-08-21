import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Bug, ScrollText } from 'lucide-react';

import { type CrashInfo } from '~main/types';
import { api } from '~renderer/utils/api';
import { useT } from '~renderer/i18n';
import { BUG_REPORT_URL } from '~renderer/utils/links';

import TextButton from './styled/TextButton';
import CheckboxInput from './form/CheckboxInput';
import CloseButton from './styled/CloseButton';

const GameCrashDialog = () => {
	const t = useT();
	const ref = useRef<HTMLDialogElement>(null);
	const [info, setInfo] = useState<CrashInfo>();
	const [dontShowAgain, setDontShowAgain] = useState(false);

	api.launcher.crash.useSubscription(undefined, { onData: setInfo });
	const acknowledge = api.launcher.acknowledgeCrash.useMutation();
	const setPref = api.preferences.set.useMutation();
	const openLogFile = api.general.openLogFile.useMutation();
	const openLink = api.general.openLink.useMutation();

	useEffect(() => {
		if (info && !ref.current?.open) ref.current?.showModal();
		else if (!info) ref.current?.close();
	}, [info]);

	useEffect(() => {
		const r = ref.current;
		const onClose = () => {
			if (dontShowAgain) void setPref.mutateAsync({ showCrashDialog: false });
			void acknowledge.mutateAsync();
		};
		r?.addEventListener('close', onClose);
		return () => r?.removeEventListener('close', onClose);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dontShowAgain]);

	return createPortal(
		<dialog
			ref={ref}
			className="h-full w-full items-center justify-center bg-[transparent] backdrop:backdrop-blur-md [&[open]]:flex"
		>
			<div className="tw-dialog !w-fit min-w-[440px] max-w-[560px]">
				<CloseButton close={() => ref.current?.close()} />
				<h3 className="flex items-center gap-2 text-orange">
					<AlertTriangle size={20} />
					{t('crash.title')}
				</h3>
				<hr />
				<p className="text-blueGray">{t('crash.body')}</p>
				<p className="s1 text-orange">{t('crash.unofficialNotice')}</p>
				<div className="flex flex-wrap gap-3">
					<TextButton
						icon={Bug}
						onClick={() => openLink.mutateAsync(BUG_REPORT_URL)}
						className="text-tw"
					>
						{t('crash.reportOnDiscord')}
					</TextButton>
					<TextButton
						icon={ScrollText}
						onClick={() => openLogFile.mutateAsync()}
						className="text-pink"
					>
						{t('crash.openLog')}
					</TextButton>
				</div>
				<CheckboxInput
					value={dontShowAgain}
					setValue={setDontShowAgain}
					label={t('crash.dontShowAgain')}
					className="mt-1"
				/>
			</div>
		</dialog>,
		document.body
	);
};

export default GameCrashDialog;
