import { SectionAnchor, useMessages } from '../components.tsx';
import { ConnectionsScreen } from './Connections.tsx';
import { OnboardingScreen } from './Onboarding.tsx';

/**
 * Шаг 95 [Р-217]: Channels — прежние Setup и Channel accounts одним экраном. Пока путь подключения не пройден, он — верхним разделом;
 * ниже — аккаунты каналов, разрешения записи количества, язык и пояс пространства. `section="accounts"` — прежний адрес
 * `connections` и шаг «канал» ведут сразу к аккаунтам
 */
export function ChannelsScreen({ worldId, section }: { worldId: string; section: string | null }) {
  const m = useMessages();
  return (
    <section className="channels-page">
      <h2>{m.ui.app.screens.channels}</h2>
      <p className="subtitle">{m.ui.app.subtitles.channels}</p>
      {/* Шаг 96: путь, ждущий только решения владельца, — строкой сверху; аккаунты — первыми (аудит Б15); идущий путь — чеклистом ниже */}
      <OnboardingScreen worldId={worldId} embedded slot="top" />
      <SectionAnchor id="channel-accounts" focus={section === 'accounts'} />
      <ConnectionsScreen worldId={worldId} embedded />
      <OnboardingScreen worldId={worldId} embedded slot="bottom" />
    </section>
  );
}
