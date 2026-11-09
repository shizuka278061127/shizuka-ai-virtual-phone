/** Shared by every TTS channel and the Fish server route. */
export function cleanTtsText(text: string): string {
    let cleaned = text;
    // Repeat to remove nested stage directions as well.
    let previous: string;
    do {
        previous = cleaned;
        cleaned = cleaned.replace(/\([^()]*\)|（[^（）]*）|\[[^\[\]]*\]|【[^【】]*】/g, " ");
    } while (cleaned !== previous);
    return cleaned
        .replace(/\*[^*\n]+\*/g, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200d\ufe0f\u20e3]|[\u{1f3fb}-\u{1f3ff}]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}
