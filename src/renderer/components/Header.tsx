import OctoLogo from '~renderer/assets/logo.png';

import { useT } from '~renderer/i18n';

import TextButton from './styled/TextButton';
import { TabNames, type TabType } from './TabsPanel';

type Props = {
	activeTab?: TabType;
	setActiveTab: (tab?: TabType) => void;
};

const Header = ({ activeTab, setActiveTab }: Props) => {
	const t = useT();
	return (
		<div className="-mb-3 flex select-none items-center gap-1">
			<button
				onClick={() => setActiveTab(undefined)}
				className="z-10 -my-3 mx-3 w-[180px] cursor-pointer"
			>
				<img src={OctoLogo} alt="OctoWoW" className="pointer-events-none" />
			</button>
			{TabNames.map(tab => (
				<TextButton
					key={tab}
					onClick={() => setActiveTab(tab)}
					active={activeTab === tab}
					className="uppercase"
				>
					{t(`tab.${tab}`)}
				</TextButton>
			))}
		</div>
	);
};

export default Header;
