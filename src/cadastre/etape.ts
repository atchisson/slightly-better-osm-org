/**
 * Exécute `f` et, s'il échoue, nomme l'étape dans l'erreur : « bâtiments 49007 › requête :
 * AbortError : … ». Une erreur réseau ou de flux ne dit pas d'elle-même où elle est née,
 * et depuis le monde isolé de Firefox chaque étape peut buter sur une frontière
 * différente. Les étapes imbriquées s'enchaînent dans le message, de l'extérieur vers
 * l'intérieur ; la cause d'origine est gardée dans `cause`.
 *
 * Une erreur marquée `intacte` (voir DatasetIntrouvable) passe telle quelle : son type
 * porte une décision, que l'envelopper ferait perdre.
 *
 * Module à part, et non dans download.ts : les tests du cache remplacent download.ts par
 * une maquette, qui ne doit pas emporter cet outil avec elle.
 */
export async function etape<T>(nom: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if ((e as { intacte?: unknown } | null)?.intacte === true) throw e;
    const interne = (e as { etapeSbo?: string } | null)?.etapeSbo !== undefined;
    let detail: string;
    try {
      const x = e as { name?: unknown; message?: unknown };
      detail = interne ? String(x.message) : `${String(x?.name ?? 'Error')} : ${String(x?.message ?? e)}`;
    } catch {
      detail = String(e);
    }
    const err = new Error(`${nom} › ${detail}`, { cause: interne ? (e as Error).cause : e });
    (err as Error & { etapeSbo: string }).etapeSbo = nom;
    throw err;
  }
}
