# Wasender

WhatsApp-Nachrichten aus dem Kalender und aus wiederkehrenden Terminen. Mehrere Konten teilen sich eine Empfängerliste. Admins verbinden WhatsApp und vergeben Rollen, Nutzer planen ihre eigenen Sendungen.

Diese Anleitung richtet Wasender auf einem internen Server ein. Die Vorschau in Grok bleibt davon unberührt.

## Was der Server können muss

- Node.js 22 und npm
- PostgreSQL 16, nur vom App-Server aus erreichbar
- Ausgehend HTTPS nach `graph.facebook.com` (WhatsApp Cloud API)
- Ein HTTPS-Name im internen Netz, zum Beispiel `https://wasender.intern.example`

Die Anmeldung setzt ein Secure-Cookie. Deshalb muss der Browser die Seite über HTTPS öffnen. `http://localhost` ist die einzige Ausnahme. Google- und X-Anmeldung laufen über einen externen Dienst und gehören nicht auf einen abgeschotteten Server. Intern wird mit E-Mail und Passwort gearbeitet.

Nachrichten gehen auch dann raus, wenn niemand die Seite offen hat. Dafür ruft der Server jede Minute `POST /api/pulse` auf. Ohne dieses Geheimnis passiert der Versand nur, solange ein angemeldetes Fenster offen ist.

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
export WASENDER_PULSE_SECRET="$(openssl rand -base64 32)"
# Nur setzen, wenn Exchange im eigenen Netz liegt:
# export WASENDER_ALLOW_PRIVATE_EWS=true
# Interne Zertifizierungsstelle, falls Exchange ihr vertraut:
# export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/interne-ca.pem

npm run build
```

`BETTER_AUTH_SECRET` danach nicht mehr wechseln, sonst sind alle Sitzungen ungültig.

## 3. Dienst starten

Der Prozess hört standardmäßig nur auf `127.0.0.1:3000`. Davor steht ein Reverse-Proxy mit TLS.

```bash
npm start
```

`HOST` und `PORT` ändern die Bindung, falls der Proxy auf einem anderen Rechner liegt. Dann die Datenbank und den Port nicht ins ganze Netz stellen.

Beispiel für systemd, Datei `/etc/systemd/system/wasender.service`:

```ini
[Unit]
Description=Wasender
After=network.target postgresql.service

[Service]
Type=simple
User=wasender
WorkingDirectory=/opt/whatsapp-sender
Environment=NODE_ENV=production
Environment=DATABASE_URL=postgresql://wasender:GEHEIM@127.0.0.1:5432/wasender
Environment=BETTER_AUTH_URL=https://wasender.intern.example
Environment=BETTER_AUTH_SECRET=langes-zufaelliges-geheimnis
Environment=WASENDER_PULSE_SECRET=anderes-zufaelliges-geheimnis
Environment=WASENDER_ALLOW_PRIVATE_EWS=true
ExecStart=/usr/bin/npm start
Restart=on-failure

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

## 4. Versand ohne offenes Fenster

Cron, jede Minute, auf dem App-Server:

```bash
* * * * * curl --silent --show-error --fail --max-time 30 -X POST -H "Authorization: Bearer $WASENDER_PULSE_SECRET" https://wasender.intern.example/api/pulse
```

Die Antwort nennt, wie viele Nachrichten gesendet wurden und wie viele noch warten. Ohne passendes Geheimnis antwortet der Pfad mit 401, und wenn `WASENDER_PULSE_SECRET` gar nicht gesetzt ist, mit 404.

Pro Aufruf gehen höchstens drei fällige Nachrichten raus. Eine Minute Abstand reicht für den normalen Betrieb.

## 5. Erstes Konto und WhatsApp

1. `https://wasender.intern.example` öffnen und das erste Konto anlegen. Dieses Konto ist Admin. Weitere Personen registrieren sich selbst.
2. Unter **Konten** die Rolle setzen und eine Telefonnummer eintragen. Nur Konten mit Nummer tauchen in der Empfängerauswahl auf.
3. Unter **Empfänger** Kontakte anlegen, die kein Konto brauchen.
4. Unter **Anbindung** die WhatsApp Cloud API eintragen:
   - In der [Meta for Developers](https://developers.facebook.com/) eine WhatsApp-Business-App
   - Phone Number ID der Absendernummer
   - Dauerhaftes Zugriffstoken mit der Berechtigung `whatsapp_business_messaging`
   - Landesvorwahl `49` und Zeitzone `Europe/Berlin`, falls nichts anderes gilt
5. Die Vorlage im WhatsApp-Manager muss für Nachrichten ausserhalb des 24-Stunden-Fensters freigegeben sein, sonst lehnt Meta den Versand ab. Wasender schickt den Text als normale Session-Nachricht.

Das Token bleibt in der Datenbank. Die Oberfläche zeigt später nur die letzten vier Zeichen.

## 6. Kalender

| Quelle | Wann |
|---|---|
| Beispiel | Nur zum Ausprobieren, ohne Zugang |
| Microsoft 365 | Graph-Token mit `Calendars.Read`, braucht ausgehend `graph.microsoft.com` |
| Exchange EWS | Adresse `https://mail.firma.example/EWS/Exchange.asmx`, Benutzer und Kennwort oder Bearer-Token |
| Outlook über Grok | Nur in der Grok-Vorschau, nicht auf dem internen Server |

Private Adressen, `.local` und `.internal` sind abgelehnt, bis `WASENDER_ALLOW_PRIVATE_EWS=true` gesetzt ist. Cloud-Metadaten-Adressen bleiben auch dann gesperrt. EWS muss HTTPS sprechen. Kennwort nicht in die URL schreiben.

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

Zugangstoken, Datenbankpasswort und die beiden Geheimnisse bleiben in der Dienstumgebung. Eine `.env` im Projektordner wird nicht mit ausgeliefert und sollte dort auch nicht liegen bleiben.
