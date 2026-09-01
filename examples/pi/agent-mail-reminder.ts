import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * One-shot agent-mail reminder adapter for Pi.
 *
 * This assumes Pi already runs agent-mail's MCP server under the same stable
 * session identity. It checks only after Pi is fully settled; it starts no
 * timer, watcher, or polling loop.
 */
export default function agentMailReminder(pi: ExtensionAPI): void {
  pi.on("agent_settled", async () => {
    const command = process.env.AGENT_MAIL_BIN || "agent-mail";
    const result = await pi.exec(
      command,
      ["remind", "--format", "pi", "--event", "Stop"],
      { timeout: 5000 },
    );

    // Exit 2 is agent-mail's persisted, newly-unannounced edge signal. Every
    // other result fails open and leaves Pi settled.
    const reminder = result.stderr.trim();
    if (result.code !== 2 || reminder === "") return;

    pi.sendMessage(
      {
        customType: "agent-mail-reminder",
        content: reminder,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });
}
