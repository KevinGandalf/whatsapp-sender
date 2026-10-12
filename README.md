# WASender

WhatsApp-Nachrichten aus dem Kalender und aus wiederkehrenden Terminen. Mehrere Konten teilen sich eine Empfängerliste. Admins verbinden WhatsApp und vergeben Rollen, Nutzer planen ihre eigenen Sendungen.

Diese Anleitung richtet WASender auf einem internen Server ein.

## Was der Server können muss

- Node.js 22 und npm
- PostgreSQL 16, nur vom App-Server aus erreichbar
- Ausgehend HTTPS nach `web.whatsapp.com` (verknüpftes Gerät, wie WhatsApp Web) und, falls genutzt, nach `graph.facebook.com`
- Ein HTTPS-Name im internen Netz, zum Beispiel `https://wasender.intern.example`

Die Anmeldung setzt ein Secure-Cookie. Deshalb muss der Browser die Seite über HTTPS öffnen. `http://localhost` ist die einzige Ausnahme. Angemeldet wird mit E-Mail und Passwort. Es gibt keine Anmeldung über Google oder Grok.

Nachrichten gehen raus, solange der Dienst läuft. Niemand muss angemeldet sein und kein Fenster muss offen bleiben. Der Prozess prüft alle 15 Sekunden selbst, hält die WhatsApp-Sitzung verbunden, legt fällige Regeltermine an und verschickt sie. Kalenderregeln über Microsoft Graph oder Exchange liest er alle fünf Minuten nach. Schlägt ein Versand kurz fehl, bleibt die Nachricht in der Warteschlange und wird mit Abstand erneut versucht.

## 1. Datenbank

```bash
sudo -u postgres createuser --pwprompt wasender
sudo -u postgres createdb --owner=wasender wasender
```

Die Tabellen legt der erste Build selbst an. Es gibt kein separates Migrationskommando, das man vergessen müsste: `npm run build` führt es aus, sobald `DATABASE_URL` gesetzt ist.

## 2. Code holen und bauen

```bash
git clone https://github.com/KevinGandalf/whatsapp-sender.git
cd whatsapp-sender
npm ci
```

Die Variablen gehören in die Dienstumgebung, nicht ins Repository. `BETTER_AUTH_URL` muss exakt die Adresse sein, die im Browser steht, inklusive `https://` und ohne Schrägstrich am Ende.

```bash
export DATABASE_URL="postgresql://wasender:GEHEIM@127.0.0.1:5432/wasender"
export BETTER_AUTH_URL="https://wasender.intern.example"
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
export VORLAUF_DATA_KEY="$(openssl rand -base64 32)"
# Internes Zertifikat von Exchange, falls der Server ihm nicht vertraut:
# export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/interne-ca.pem
# Nur wenn Exchange ein selbstsigniertes Zertifikat hat und keine interne CA vorliegt:
# export VORLAUF_EWS_INSECURE_TLS=true

npm run build
```

`BETTER_AUTH_SECRET` und `VORLAUF_DATA_KEY` danach nicht mehr wechseln. Der erste signiert die Anmeldung, der zweite entschlüsselt Nachrichten und Empfänger. Fehlt der Datenschlüssel, legt der Dienst einmalig `data/data-key` an. Diese Datei oder die Variable sichern. Ohne sie sind die gespeicherten Texte nicht mehr lesbar.

## 3. Dienst starten

Der Prozess hört standardmäßig nur auf `127.0.0.1:3000`. Davor steht ein Reverse-Proxy mit TLS.

```bash
npm start
```

`HOST` und `PORT` ändern die Bindung, falls der Proxy auf einem anderen Rechner liegt. Dann die Datenbank und den Port nicht ins ganze Netz stellen.

Beispiel für systemd, Datei `/etc/systemd/system/wasender.service`:

```ini
[Unit]
Description=WASender
After=network.target postgresql.service

[Service]
Type=simple
User=wasender
WorkingDirectory=/opt/whatsapp-sender
Environment=NODE_ENV=production
Environment=DATABASE_URL=postgresql://wasender:GEHEIM@127.0.0.1:5432/wasender
Environment=BETTER_AUTH_URL=https://wasender.intern.example
Environment=BETTER_AUTH_SECRET=langes-zufaelliges-geheimnis
Environment=VORLAUF_DATA_KEY=base64-aus-openssl
Environment=VORLAUF_PULSE_SECRET=anderes-zufaelliges-geheimnis
Environment=VORLAUF_EWS_INSECURE_TLS=false
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wasender
```

Caddy auf demselben Rechner:

```caddy
wasender.intern.example {
  reverse_proxy 127.0.0.1:3000
}
```

Der Proxy muss `Host` und `X-Forwarded-Proto` durchreichen. Caddy tut das von selbst. Die Seite danach nur unter `BETTER_AUTH_URL` öffnen, nicht über die nackte IP.

## 4. Versand ohne Anmeldung

Sobald `npm start` läuft, verschickt der Prozess von selbst. Urlaub oder ein geschlossener Browser ändern daran nichts. `systemd` mit `Restart=always` holt den Dienst nach einem Absturz wieder hoch. Die WhatsApp-Sitzung verbindet sich aus `data/wa-auth` neu, ohne dass jemand den QR-Code noch einmal scannt.

Ein Cronjob ist nicht nötig. Wer zusätzlich von außen prüfen will, kann weiter `POST /api/pulse` mit `VORLAUF_PULSE_SECRET` aufrufen. Ohne dieses Geheimnis antwortet der Pfad mit 404. Der interne Takt läuft davon unabhängig.


## 5. Erstes Konto und WhatsApp

1. `https://wasender.intern.example` öffnen und das erste Konto anlegen. Dieses Konto ist Admin.
2. Unter **Anbindung** auf **Code anzeigen** gehen. Am Telefon: WhatsApp, verknüpfte Geräte, Gerät hinzufügen, Code scannen. Das ist dieselbe Art Sitzung wie WhatsApp Web. Sie bleibt auf dem Server, solange der Dienst läuft, und nach einem Neustart ohne neuen Code weiter, weil die Anmeldung unter `data/wa-auth` liegt. Diesen Ordner sichern und nicht ins Git legen.
3. Unter **Chats** stehen danach die Unterhaltungen und die letzten Nachrichten. Neue Nachrichten kommen von selbst nach. Antworten aus dem Chat gehen über diese Sitzung.
4. Geplante Regeltermine benutzen dieselbe Sitzung. Die Cloud API darunter ist nur der Ersatz, falls kein Gerät verknüpft ist.
5. Unter **Konten** Rollen und Telefonnummern setzen. Unter **Empfänger** Kontakte anlegen, die kein Konto brauchen.

Cloud API, falls doch benötigt: Phone Number ID und ein dauerhaftes Token mit `whatsapp_business_messaging` aus der Meta-App. Das Token bleibt in der Datenbank. Die Oberfläche zeigt später nur die letzten vier Zeichen.

WhatsApp muss vom Server aus `web.whatsapp.com` erreichen. Medien werden nicht heruntergeladen, im Verlauf steht dann nur die Art, zum Beispiel „Bild“. WhatsApp kann so eine Sitzung trennen. Sie ist für den eigenen Ablauf gedacht, nicht für Massenversand.


## 6. Kalender

| Quelle | Wann |
|---|---|
| Beispiel | Nur zum Ausprobieren, ohne Zugang |
| Exchange EWS | Lokaler Exchange. Adresse `https://exchange.firma.local/EWS/Exchange.asmx`. Anmeldung NTLM als `DOMÄNE\benutzer` oder `benutzer@firma.local`, sonst Basic oder Bearer |
| Microsoft 365 | Graph-Token mit `Calendars.Read`, braucht ausgehend `graph.microsoft.com` |

Private Namen, `.local` und Adressen im eigenen Netz sind für EWS erlaubt. Cloud-Metadaten-Adressen bleiben gesperrt. HTTP nur im privaten Netz, sonst HTTPS. Kennwort nicht in die URL schreiben. Vertraut der Server dem Exchange-Zertifikat nicht, `NODE_EXTRA_CA_CERTS` setzen. `VORLAUF_EWS_INSECURE_TLS=true` ist nur der Notnagel für ein selbstsigniertes Zertifikat.

Regeltermine hängen nicht am Kalender. Sie laufen täglich, an gewählten Wochentagen oder monatlich am Tag 1–28.

Kalenderregeln erzeugen Nachrichten, wenn jemand die geladenen Termine bewusst anwendet. Sie wiederholen sich nicht von selbst.

## 7. Aktualisieren

```bash
cd /opt/whatsapp-sender
git pull
npm ci
npm run build
sudo systemctl restart wasender
```

`DATABASE_URL` muss beim Build gesetzt sein, damit neue Tabellen ankommen. Angewendete Migrationsdateien nicht nachträglich ändern.

## 8. Wenn die Anmeldung scheitert

- „Invalid origin“: die geöffnete Adresse ist nicht `BETTER_AUTH_URL`. Dazu zählen `http` statt `https`, ein anderer Port und ein abschliessender Schrägstrich.
- Die Seite lädt, aber das Konto bleibt weg: der Dienst wurde ohne dasselbe `BETTER_AUTH_SECRET` neu gestartet, oder der Browser hat die Seite nicht über HTTPS geöffnet.
- Es gibt keinen Admin: nur das allererste Konto in einer leeren Datenbank wird Admin. Ein zweites Konto kann ein bestehender Admin unter **Konten** hochstufen.

## Was nicht ins Repository gehört

Zugangstoken, Datenbankpasswort, Anmeldgeheimnis und `VORLAUF_DATA_KEY` bleiben in der Dienstumgebung. `data/data-key` und `data/wa-auth` ebenfalls nicht einchecken.

Nachrichten, Empfängernamen, Telefonnummern, Chatverläufe und die hinterlegten Kalender- und WhatsApp-Zugänge liegen in der Datenbank als AES-256-GCM. Zeiten, Status und die E-Mail der Anmeldung bleiben lesbar, sonst kann der Dienst nicht planen und nicht anmelden. Bestehende Klartextzeilen werden beim nächsten Start verschlüsselt.

