import { useForm, type UseFormReturn } from 'react-hook-form';
import { useEffect } from 'react';
import cls from 'classnames';

import { api } from '~renderer/utils/api';
import { ConfigWtfSchema } from '~common/schemas';
import zodResolver from '~renderer/utils/zodResolver';
import useScrollHint from '~renderer/utils/useScrollHint';
import { useT } from '~renderer/i18n';

import TextButton from '../styled/TextButton';
import CheckboxInput from '../form/CheckboxInput';
import NumberGrabInput from '../form/NumberGrabInput';

type ItemProps = {
	type?: 'checkbox' | 'number';
	id: keyof ConfigWtfSchema;
	label: string;
	recommended?: boolean;
	text: string;
	min?: number;
	max?: number;
	step?: number;
	sensitivity?: number;
	form: UseFormReturn<ConfigWtfSchema>;
};

const Item = ({
	type = 'checkbox',
	id,
	label,
	recommended,
	text,
	form,
	...props
}: ItemProps) => {
	const { watch, setValue, register } = form;
	const setOpts = {
		shouldTouch: true,
		shouldDirty: true,
		shouldValidate: true
	} as const;
	const watched = type === 'checkbox' ? watch(id) : undefined;
	const registered = type === 'number' ? register(id) : undefined;
	return (
		<>
			<p className={cls({ 'text-warmGreen': recommended })}>{label}</p>
			{type === 'checkbox' && (
				<CheckboxInput
					value={!!watched}
					setValue={v => setValue(id, v, setOpts)}
					className="justify-self-center"
				/>
			)}
			{type === 'number' && registered && (
				<NumberGrabInput
					{...registered}
					{...props}
					setValue={v => setValue(id, v, setOpts)}
				/>
			)}
			<p className="s1 text-blueGray">{text}</p>
		</>
	);
};

const TweaksTab = () => {
	const t = useT();
	const { data: pref } = api.preferences.get.useQuery();
	const setPref = api.preferences.set.useMutation();

	const applyPatch = api.patcher.apply.useMutation();
	const verify = api.updater.verify.useMutation();

	const form = useForm<ConfigWtfSchema>({
		defaultValues: pref?.config ?? {},
		resolver: zodResolver(ConfigWtfSchema)
	});
	const { handleSubmit, reset, formState } = form;

	const { data: hw } = api.general.hardware.useQuery();
	const recommendedFarClip = hw?.recommendedFarClip;
	const farClipValue = form.watch('farClip');
	const farClipText =
		t('tweaks.farClip.text') +
		(recommendedFarClip != null
			? ' ' + t('tweaks.farClip.recommendedHint', { value: recommendedFarClip })
			: '');

	const isApplying =
		setPref.isLoading || applyPatch.isLoading || verify.isLoading;

	useEffect(() => {
		pref && reset(pref.config);
	}, [reset, pref]);

	const scrollRef = useScrollHint<HTMLDivElement>();

	return (
		<form
			onSubmit={handleSubmit(async config => {
				await setPref.mutateAsync({ config, farClipUserSet: true });
				await applyPatch.mutateAsync();
				await verify.mutateAsync();

				reset(config);
			})}
			className="tw-surface flex min-h-0 flex-grow flex-col gap-3"
		>
			<div
				ref={scrollRef}
				className="relative -m-4 -mb-3 grid flex-grow grid-cols-[auto_auto_1fr] content-start items-center gap-x-3 gap-y-1 overflow-y-auto p-4 pb-3"
			>
				<Item
					form={form}
					id="alwaysAutoLoot"
					label={t('tweaks.alwaysAutoLoot.label')}
					text={t('tweaks.alwaysAutoLoot.text')}
				/>
				<Item
					form={form}
					id="largeAddress"
					label={t('tweaks.largeAddress.label')}
					text={t('tweaks.largeAddress.text')}
					recommended
				/>
				<Item
					form={form}
					type="number"
					id="nameplateRange"
					label={t('tweaks.nameplateRange.label')}
					text={t('tweaks.nameplateRange.text')}
					min={0}
					max={41}
				/>

				<h4 className="tw-color col-span-3 mt-3">
					{t('tweaks.cameraHeading')}
				</h4>
				<Item
					form={form}
					id="fieldOfView"
					label={t('tweaks.fieldOfView.label')}
					type="number"
					text={t('tweaks.fieldOfView.text')}
					min={90}
					max={180}
					step={5}
				/>
				<Item
					form={form}
					id="farClip"
					label={t('tweaks.farClip.label')}
					type="number"
					text={farClipText}
					recommended={
						recommendedFarClip != null &&
						Number(farClipValue) === recommendedFarClip
					}
					min={100}
					max={10000}
					sensitivity={3}
				/>
				<Item
					form={form}
					id="frillDistance"
					label={t('tweaks.frillDistance.label')}
					type="number"
					text={t('tweaks.frillDistance.text')}
					min={0}
					max={300}
					sensitivity={0.3}
				/>
				<Item
					form={form}
					id="cameraDistance"
					label={t('tweaks.cameraDistance.label')}
					type="number"
					text={t('tweaks.cameraDistance.text')}
					min={50}
					max={100}
				/>

				<h4 className="tw-color col-span-3 mt-3">
					{t('tweaks.soundsHeading')}
				</h4>
				<Item
					form={form}
					id="soundInBackground"
					label={t('tweaks.soundInBackground.label')}
					text={t('tweaks.soundInBackground.text')}
					recommended
				/>
			</div>
			<hr />
			<div className="-mb-4 -mt-3 flex items-center gap-2 py-2">
				<p className="s1 flex-grow text-blueGray">
					{applyPatch.isError ? (
						<span className="text-orange">
							{t('tweaks.applyFailed', {
								message: applyPatch.error?.message ?? ''
							})}
						</span>
					) : (
						<>
							<span className="s1 text-warmGreen">
								{t('tweaks.highlighted')}
							</span>{' '}
							{t('tweaks.recommendedNote')}
						</>
					)}
				</p>
				<TextButton
					onClick={async () => {
						const config =
							recommendedFarClip != null
								? { ...ConfigWtfSchema.parse({}), farClip: recommendedFarClip }
								: ConfigWtfSchema.parse({});
						await setPref.mutateAsync({ config, farClipUserSet: false });
						reset(config);
					}}
				>
					{t('tweaks.reset')}
				</TextButton>
				{(formState.isDirty || isApplying) && (
					<TextButton type="submit" loading={isApplying} className="text-green">
						{t('tweaks.apply')}
					</TextButton>
				)}
			</div>
		</form>
	);
};

export default TweaksTab;
