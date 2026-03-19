const REPO_OWNER = 'Slowed-hub';
const REPO_NAME  = 'MYLINKS';
const BRANCH     = 'main';

async function verifyDiscordToken(token) {
  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return null;
  return await res.json();
}

async function getFileSHA(path, env) {
  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN_SECRET}`, 'User-Agent': 'mylinks-worker' }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return { sha: data.sha, content: data.content };
}

async function putFile(path, base64, message, sha, env) {
  const body = { message, content: base64, branch: BRANCH };
  if (sha) body.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN_SECRET}`, 'Content-Type': 'application/json', 'User-Agent': 'mylinks-worker' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
  return `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}/${path}`;
}

async function deleteFile(path, sha, message, env) {
  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN_SECRET}`, 'Content-Type': 'application/json', 'User-Agent': 'mylinks-worker' },
    body: JSON.stringify({ message, sha, branch: BRANCH })
  });
  return res.ok;
}

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    const json = (data, status=200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // ── GET chars.json ──
    if (request.method === 'GET') {
      try {
        const res = await fetch(`https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}/chars.json?t=${Date.now()}`);
        if (!res.ok) return json([]);
        const data = await res.json();
        return json(data);
      } catch(e) { return json([]); }
    }

    // ── POST : upload fichier + mettre à jour chars.json ──
    if (request.method === 'POST') {
      try {
        const { filename, content, folder, discordToken, charData } = await request.json();

        // Vérifier Discord
        if (!discordToken) return json({ error: 'Non authentifié' }, 401);
        const user = await verifyDiscordToken(discordToken);
        if (!user) return json({ error: 'Token Discord invalide' }, 401);

        let url = null;

        // Upload fichier si fourni
        if (filename && content) {
          const dir = folder || 'chf';
          const filePath = `${dir}/${filename}`;
          const existing = await getFileSHA(filePath, env);
          const base64 = content.includes(',') ? content.split(',')[1] : content;
          url = await putFile(filePath, base64, `Upload by ${user.username}: ${filePath}`, existing?.sha, env);
        }

        // Mettre à jour chars.json si charData fourni
        if (charData) {
          const existing = await getFileSHA('chars.json', env);
          let chars = [];
          if (existing?.content) {
            try { chars = JSON.parse(atob(existing.content.replace(/\n/g,''))); } catch(e) {}
          }
          // Ajouter ou mettre à jour le personnage
          const idx = chars.findIndex(c => c.id === charData.id);
          if (idx >= 0) chars[idx] = charData;
          else chars.unshift(charData);
          const newContent = btoa(unescape(encodeURIComponent(JSON.stringify(chars, null, 2))));
          await putFile('chars.json', newContent, `Update chars: ${charData.name} by ${user.username}`, existing?.sha, env);
        }

        return json({ url, discordId: user.id });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── DELETE : supprimer fichier + retirer de chars.json ──
    if (request.method === 'DELETE') {
      try {
        const { filePath, discordToken, ownerId, charId } = await request.json();
        if (!discordToken) return json({ error: 'Non authentifié' }, 401);
        const user = await verifyDiscordToken(discordToken);
        if (!user) return json({ error: 'Token Discord invalide' }, 401);
        if (ownerId && user.id !== ownerId) return json({ error: 'Non autorisé' }, 403);

        // Supprimer fichier si filePath fourni
        if (filePath) {
          const existing = await getFileSHA(filePath, env);
          if (existing?.sha) await deleteFile(filePath, existing.sha, `Delete by ${user.username}: ${filePath}`, env);
        }

        // Retirer de chars.json si charId fourni
        if (charId) {
          const existing = await getFileSHA('chars.json', env);
          if (existing?.content) {
            let chars = [];
            try { chars = JSON.parse(atob(existing.content.replace(/\n/g,''))); } catch(e) {}
            chars = chars.filter(c => c.id !== charId);
            const newContent = btoa(unescape(encodeURIComponent(JSON.stringify(chars, null, 2))));
            await putFile('chars.json', newContent, `Remove char ${charId} by ${user.username}`, existing.sha, env);
          }
        }

        return json({ success: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    return new Response('Method not allowed', { status: 405, headers: cors });
  }
};
