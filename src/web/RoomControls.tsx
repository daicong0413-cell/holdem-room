import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { ClientMessage, TableView } from "../server/protocol.ts";
import type { PersonaInfo } from "../server/room.ts";
import { money } from "../shared/format.ts";
import { useI18n } from "./i18n.tsx";

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const id = useId();
  const { t } = useI18n();
  return <div className="modal-backdrop" onClick={onClose} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
    <section className="modal room-control-modal" role="dialog" aria-modal="true" aria-labelledby={id} onClick={(event) => event.stopPropagation()}>
      <header><h2 id={id}>{title}</h2><button type="button" onClick={onClose} aria-label={t("关闭", "Close")}>×</button></header>
      {children}
    </section>
  </div>;
}

export function SeatPicker({ index, defaultBuyIn, minBuyIn, personas, canManage, canSit, onSit, onAddBot }:
  { index: number; defaultBuyIn: number; minBuyIn: number; personas: readonly PersonaInfo[]; canManage: boolean; canSit: boolean;
    onSit: (seat: number, amount: number) => void; onAddBot: (seat: number, persona: string, amount: number) => void }) {
  const { t } = useI18n();
  const [amount, setAmount] = useState(defaultBuyIn);
  const [persona, setPersona] = useState(personas[0]?.id ?? "");
  const chosen = personas.some((item) => item.id === persona) ? persona : personas[0]?.id ?? "";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value === "bot") onAddBot(index, chosen, amount);
    else onSit(index, amount);
  };
  return <form className="seat-options" onSubmit={submit}>
    <label>{t("买入筹码", "Buy-in chips")}
      <input autoFocus type="number" inputMode="numeric" required min={minBuyIn} max={1_000_000} step={1} value={amount}
        onChange={(event) => setAmount(Number(event.target.value))} />
    </label>
    {canSit ? <button type="submit" value="human" className="primary">{t("入座")}</button> : null}
    {canManage ? <>
      <label>{t("机器人风格", "Bot personality")}<select aria-label={t("机器人风格", "Bot personality")} value={chosen} disabled={!personas.length} onChange={(event) => setPersona(event.target.value)}>
        {personas.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <button type="submit" value="bot" disabled={!personas.length}>{t("加机器人")}</button>
    </> : null}
    <p className="hint">{t("中途入座从下一手开始。", "New seats join on the next deal.")}</p>
  </form>;
}

export function BuyInDialog({ view, onSend, onClose }: { view: TableView; onSend: (message: ClientMessage) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [amount, setAmount] = useState(view.settings.startingStack);
  const hero = view.seats.find((seat) => seat.isYou)!;
  return <Dialog title={t("追加买入", "Add chips")} onClose={onClose}>
    <p>{t(`当前筹码 ${money(hero.stack)}，待到账 ${money(hero.pendingBuyIn)}。`, `Stack ${money(hero.stack)} · Pending ${money(hero.pendingBuyIn)}.`)}</p>
    <form className="seat-options" onSubmit={(event) => { event.preventDefault(); onSend({ t: "rebuy", buyIn: amount }); onClose(); }}>
      <label>{t("追加金额", "Amount to add")}<input autoFocus type="number" inputMode="numeric" min={Math.max(20, view.bigBlind * 2)}
        max={Math.max(0, 1_000_000 - hero.stack - hero.committed - hero.pendingBuyIn)} step={1} required value={amount}
        onChange={(event) => setAmount(Number(event.target.value))} /></label>
      <p className="hint">{t("本手进行中追加的筹码会在结算后到账，不参与当前底池。", "Chips added during a hand arrive after settlement and do not enter the current pot.")}</p>
      <button className="primary" type="submit">{t("确认买入", "Confirm buy-in")}</button>
    </form>
  </Dialog>;
}

export function BotManager({ view, personas, onSend, onClose }: { view: TableView; personas: readonly PersonaInfo[];
  onSend: (message: ClientMessage) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [seatIndex, setSeatIndex] = useState(view.seats.find((seat) => !seat.playerId)?.index ?? -1);
  const empty = view.seats.filter((seat) => !seat.playerId);
  const target = empty.some((seat) => seat.index === seatIndex) ? seatIndex : empty[0]?.index ?? -1;
  const bots = view.seats.filter((seat) => seat.isBot);
  const unused = personas.filter((persona) => !bots.some((bot) => bot.personaId === persona.id));
  return <Dialog title={t("机器人管理", "Manage bots")} onClose={onClose}>
    <ul className="bot-management-list">
      {bots.map((bot) => <li key={bot.playerId}><div><strong>{bot.name}</strong><span>{money(bot.stack)} · {t(`座位 ${bot.index + 1}`, `Seat ${bot.index + 1}`)}</span></div>
        <button type="button" disabled={bot.leaving} onClick={() => onSend({ t: "removeBot", seat: bot.index })}>
          {bot.leaving ? t("本手结束后离桌", "Leaves after this hand") : t("离桌")}
        </button></li>)}
    </ul>
    {target >= 0 && unused.length > 0 ? <>
      <label className="bot-target">{t("上桌座位", "Seat for new bot")}<select aria-label={t("上桌座位", "Seat for new bot")} value={target} onChange={(event) => setSeatIndex(Number(event.target.value))}>
        {empty.map((seat) => <option key={seat.index} value={seat.index}>{t(`座位 ${seat.index + 1}`, `Seat ${seat.index + 1}`)}</option>)}
      </select></label>
      <SeatPicker key={target} index={target} minBuyIn={Math.max(20, view.bigBlind * 2)} defaultBuyIn={view.settings.startingStack} personas={unused} canManage canSit={false}
        onSit={() => undefined} onAddBot={(seat, persona, buyIn) => onSend({ t: "addBot", seat, persona, buyIn })} />
    </> : <p className="hint">{t("没有空位或可加入的机器人。", "No open seats or unused personalities.")}</p>}
    <p className="hint">{t("局中加入的机器人下一手发牌；局中离桌会等待本手结算。", "Bots added mid-hand join the next deal. Removing a bot waits until this hand settles.")}</p>
  </Dialog>;
}
