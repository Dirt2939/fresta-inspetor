# Fresta Inspetor

A Fresta é fechada. O Inspetor é aberto, e serve para você não precisar confiar nela.

Ele mostra o que a Fresta faz no seu PC, lendo tudo **pelo próprio Windows**, nunca pela Fresta: para onde ela se conecta, que arquivos abre, que programas inicia, se usou câmera, microfone ou localização, e que chaves guardou. E, se você quiser, trava a Fresta no Firewall do Windows para ela só alcançar o que está na lista pública.

O código cabe numa tarde de leitura: cerca de 1.400 linhas de Rust e uma página HTML sem framework.

## O que ele lê, e de onde

| O quê | De onde vem | Arquivo |
|---|---|---|
| Processos da Fresta e o que ela inicia | ETW `Microsoft-Windows-Kernel-Process` e a lista de processos do Windows (Toolhelp) | `src/watch.rs` |
| Conexões, bytes enviados e recebidos | ETW `Microsoft-Windows-Kernel-Network` e a tabela TCP do Windows (`GetExtendedTcpTable`) | `src/watch.rs` |
| Nome de cada endereço | ETW `Microsoft-Windows-DNS-Client` (as respostas que o Windows deu à Fresta) e, para o que sobrar, o DNS reverso | `src/watch.rs`, `src/win.rs` |
| Arquivos e pastas | ETW `Microsoft-Windows-Kernel-File` (abrir, criar, escrever, apagar, renomear) | `src/watch.rs` |
| Câmera, microfone, localização | O registro de uso do Windows (`CapabilityAccessManager\ConsentStore`), o mesmo de Configurações → Privacidade | `src/sensors.rs` |
| Chaves guardadas | O Gerenciador de Credenciais do Windows (`CredEnumerateW`). Mostra nome, data e tamanho, **nunca o conteúdo** | `src/keys.rs` |
| Trava | Uma regra do Firewall do Windows feita com `netsh`, visível em `wf.msc` | `src/lock.rs` |

Tudo é comparado com [`lista.json`](lista.json): cada endereço, programa, pasta e chave que a Fresta pode usar, com o motivo. A lista foi montada a partir das chamadas de rede que existem no código da Fresta e entra no programa na compilação, então um build feito daqui confere contra a lista daqui.

O Inspetor só vê o que acontece **enquanto ele está aberto** (o histórico de câmera, microfone e localização é a exceção: esse o Windows guarda sozinho).

## O que ele não faz

- **Não usa a internet.** A única coisa que ele pede à rede é DNS, ao servidor que o seu Windows já usa: para saber o endereço dos nomes da lista e o nome dos endereços que aparecem. A página tem uma CSP que não deixa ela falar com nada fora do próprio app (`tauri.conf.json`).
- Não lê o conteúdo de arquivos, de conexões ou de chaves.
- Não fala com a Fresta, nem precisa dela instalada.
- Só apaga uma chave se ela for da Fresta, e só depois de dois cliques seus.

## Por que pede administrador

Ver os eventos do kernel (ETW) e criar regras no Firewall exige. O pedido está no manifesto (`app.manifest`), não escondido no código.

## Um limite que vale saber

A janela da Fresta é desenhada pelo WebView2, um componente do Windows que outros apps também usam (Teams, o Outlook novo, os Widgets). O Inspetor acompanha os processos do WebView2 que a Fresta abriu e mostra o que eles fazem, mas o Firewall não sabe separar um WebView2 de outro. Por isso a trava vale para o `fresta.exe`; o que a janela faz é vigiado e marcado, não bloqueado.

Quando a Fresta abre algo **para você** (um link no navegador, uma pasta no Explorador, o Claude Code num terminal), o Inspetor anota que abriu, mas não segue o que esse programa faz depois: o tráfego do seu navegador não é da Fresta.

## Meus endereços

Se você ligou a Fresta a algo seu (um n8n, um Ollama em outro PC, um servidor próprio), marque em Rede → "É meu". Isso fica só neste PC, em `%APPDATA%\Fresta Inspetor\meus-enderecos.json`.

## Compilar

No Windows 10 ou 11, com o [Rust](https://rustup.rs) e as Build Tools do Visual Studio (o WebView2 já vem no Windows 11):

```
cargo build --release
```

O programa sai em `target\release\fresta-inspetor.exe`. Não há instalador: é um arquivo só.

Os testes da lista e da trava:

```
cargo test
```

### Conferir um download

Os `.exe` publicados em Releases são feitos pelo GitHub Actions a partir deste código (`.github/workflows/build.yml`) e levam uma atestação de origem. Para conferir que o arquivo que você baixou saiu deste repositório:

```
gh attestation verify fresta-inspetor.exe --repo Dirt2939/fresta-inspetor
```

## Licença

MIT, veja [LICENSE](LICENSE). As fontes em `ui/fonts` (Bricolage Grotesque e Geist) são da SIL Open Font License, com os textos ao lado delas.
