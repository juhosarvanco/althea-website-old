# Althea — vanha sivusto

**[Avaa vanha sivusto selaimessa](https://juhosarvanco.github.io/althea-website-old/)**

Tämä on erillinen arkistokopio Althean sivustosta ennen lokakuun 2026 uudistusta.
Sivun tekstit, kuvat ja ulkoasu ovat 21.9.2026 tallennetusta versiosta:
`9dae81392ce82d40fd2467aeb95b739e48900f17`.

Nykyisen sivuston repo: https://github.com/juhosarvanco/althea-website

## Tiedostot

- `site/index.html`: vanha julkaistu sivu.
- `site/assets/`: sivun kuvat ja fontit.
- `project/`: alkuperäiset suunnittelutiedostot.
- `.github/workflows/pages.yml`: arkistosivun julkaisu GitHub Pagesiin.

GitHub Pages julkaisee sivun ja sen kuvat/fontit. Hallintaeditoria ja Netlify-taustapalveluita ei julkaista Pagesiin.

## Paikallinen katselu

Suorita repon kansiossa `node tools/serve.mjs` ja avaa http://127.0.0.1:8788/.
Jos portti on käytössä, valitse toinen portti, esimerkiksi `PORT=8790 node tools/serve.mjs`.

## Julkaiseminen

`main`-haaraan tehdyt muutokset käynnistävät GitHub Actionsin, joka julkaisee katseluversion GitHub Pagesiin.
Työnkulun voi käynnistää myös repon Actions-välilehdeltä.
