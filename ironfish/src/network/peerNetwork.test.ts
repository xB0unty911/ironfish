/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* eslint-disable @typescript-eslint/no-unsafe-member-access */
jest.mock('ws')

import type WSWebSocket from 'ws'
import http from 'http'
import net from 'net'
import ws from 'ws'
import { Assert } from '../assert'
import { VerificationResultReason } from '../consensus/verifier'
import { Block, Transaction } from '../primitives'
import { BlockSerde, SerializedCompactBlock } from '../primitives/block'
import { BlockHeaderSerde } from '../primitives/blockheader'
import {
  useAccountFixture,
  useBlockWithTx,
  useMinerBlockFixture,
  useMinersTxFixture,
} from '../testUtilities'
import { mockChain, mockNode, mockTelemetry } from '../testUtilities/mocks'
import { createNodeTest } from '../testUtilities/nodeTest'
import { CannotSatisfyRequest } from './messages/cannotSatisfyRequest'
import { DisconnectingMessage } from './messages/disconnecting'
import {
  GetBlockTransactionsRequest,
  GetBlockTransactionsResponse,
} from './messages/getBlockTransactions'
import { GetCompactBlockRequest, GetCompactBlockResponse } from './messages/getCompactBlock'
import { NewBlockMessage } from './messages/newBlock'
import { NewBlockHashesMessage } from './messages/newBlockHashes'
import { NewBlockV2Message } from './messages/newBlockV2'
import { NewPooledTransactionHashes } from './messages/newPooledTransactionHashes'
import { NewTransactionMessage } from './messages/newTransaction'
import { NewTransactionV2Message } from './messages/newTransactionV2'
import { PeerListMessage } from './messages/peerList'
import {
  PooledTransactionsRequest,
  PooledTransactionsResponse,
} from './messages/pooledTransactions'
import { PeerNetwork } from './peerNetwork'
import {
  getConnectedPeer,
  getConnectedPeersWithSpies,
  mockHostsStore,
  mockPrivateIdentity,
  peerMessage,
} from './testUtilities'
import { NetworkMessageType } from './types'
import { VERSION_PROTOCOL } from './version'

jest.useFakeTimers()

describe('PeerNetwork', () => {
  describe('stop', () => {
    const nodeTest = createNodeTest()
    it('stops the peer manager', async () => {
      const { peerNetwork } = nodeTest

      const stopSpy = jest.spyOn(peerNetwork.peerManager, 'stop')
      await peerNetwork.stop()
      expect(stopSpy).toBeCalled()
    })
  })

  describe('when validation fails', () => {
    const nodeTest = createNodeTest()

    it('throws an exception', async () => {
      const { peerNetwork } = nodeTest

      const { peer } = getConnectedPeer(peerNetwork.peerManager)
      const message = new PeerListMessage([])
      await expect(
        peerNetwork['handleMessage'](peer, {
          peerIdentity: peer.getIdentityOrThrow(),
          message,
        }),
      ).rejects.not.toBeUndefined()
      await peerNetwork.stop()
    })
  })

  describe('when peers connect', () => {
    it('changes isReady', async () => {
      const peerNetwork = new PeerNetwork({
        identity: mockPrivateIdentity('local'),
        agent: 'sdk/1/cli',
        webSocket: ws,
        node: mockNode(),
        chain: mockChain(),
        minPeers: 1,
        hostsStore: mockHostsStore(),
        telemetry: mockTelemetry(),
      })

      expect(peerNetwork.isReady).toBe(false)

      const readyChanged = jest.fn()
      peerNetwork.onIsReadyChanged.on(readyChanged)

      peerNetwork.start()
      expect(peerNetwork.isReady).toBe(false)

      const { peer } = getConnectedPeer(peerNetwork.peerManager)
      expect(peerNetwork.isReady).toBe(true)

      peer.close()
      expect(peerNetwork.isReady).toBe(false)

      await peerNetwork.stop()
      expect(peerNetwork.isReady).toBe(false)

      expect(readyChanged).toBeCalledTimes(2)
      expect(readyChanged).toHaveBeenNthCalledWith(1, true)
      expect(readyChanged).toHaveBeenNthCalledWith(2, false)
    })
  })

  describe('when at max peers', () => {
    it('rejects websocket connections', async () => {
      const wsActual = jest.requireActual<typeof WSWebSocket>('ws')

      const peerNetwork = new PeerNetwork({
        identity: mockPrivateIdentity('local'),
        agent: 'sdk/1/cli',
        webSocket: wsActual,
        node: mockNode(),
        chain: mockChain(),
        listen: true,
        port: 0,
        minPeers: 1,
        maxPeers: 0,
        hostsStore: mockHostsStore(),
        telemetry: mockTelemetry(),
      })

      const rejectSpy = jest
        .spyOn(peerNetwork.peerManager, 'shouldRejectDisconnectedPeers')
        .mockReturnValue(true)

      // Start the network so it creates the webSocketServer
      peerNetwork.start()
      const server = peerNetwork['webSocketServer']
      Assert.isNotUndefined(server, `server`)

      const socket = new net.Socket()
      const req = new http.IncomingMessage(socket)
      const conn = new ws('test')

      const sendSpy = jest.spyOn(conn, 'send').mockReturnValue(undefined)
      const closeSpy = jest.spyOn(conn, 'close').mockReturnValue(undefined)
      server.server.emit('connection', conn, req)
      await peerNetwork.stop()

      expect(rejectSpy).toHaveBeenCalled()
      expect(sendSpy).toHaveBeenCalled()
      expect(closeSpy).toHaveBeenCalled()

      // Check that the disconnect message was serialized properly
      const args = sendSpy.mock.calls[0][0]
      expect(typeof args).toEqual('string')
      const message = JSON.parse(args) as DisconnectingMessage
      expect(message.type).toEqual(NetworkMessageType.Disconnecting)
    })
  })

  describe('handles requests for compact blocks', () => {
    const nodeTest = createNodeTest()

    it('should respond to GetCompactBlockRequest', async () => {
      const { peerNetwork, node } = nodeTest

      const account = await useAccountFixture(node.accounts, 'accountA')
      const block = await useMinerBlockFixture(node.chain, undefined, account, node.accounts)
      const transaction1 = block.transactions[0]
      const transaction2 = await useMinersTxFixture(node.accounts, account)
      const transaction3 = await useMinersTxFixture(node.accounts, account)

      await expect(node.chain).toAddBlock(block)

      await node.chain.transactions.put(block.header.hash, {
        transactions: [transaction1, transaction2, transaction3],
      })

      const compactBlock: SerializedCompactBlock = {
        header: BlockHeaderSerde.serialize(block.header),
        transactions: [{ index: 0, transaction: transaction1.serialize() }],
        transactionHashes: [transaction2.hash(), transaction3.hash()],
      }

      const { peer } = getConnectedPeer(peerNetwork.peerManager)
      const peerIdentity = peer.getIdentityOrThrow()

      const sendSpy = jest.spyOn(peer, 'send')

      const rpcId = 432
      const message = new GetCompactBlockRequest(block.header.hash, rpcId)
      const response = new GetCompactBlockResponse(compactBlock, rpcId)

      await peerNetwork.peerManager.onMessage.emitAsync(peer, { peerIdentity, message })

      expect(sendSpy).toHaveBeenCalledWith(response)
    })

    it('responds with CannotSatisfy when requesting an old compact block', async () => {
      const { peerNetwork, node } = nodeTest

      const account = await useAccountFixture(node.accounts, 'accountA')
      for (let i = 0; i < 6; i++) {
        const block = await useMinerBlockFixture(node.chain, undefined, account, node.accounts)
        await expect(node.chain).toAddBlock(block)
      }

      const { peer } = getConnectedPeer(peerNetwork.peerManager)
      const peerIdentity = peer.getIdentityOrThrow()

      const sendSpy = jest.spyOn(peer, 'send')

      const rpcId = 432
      const message = new GetCompactBlockRequest(node.chain.genesis.hash, rpcId)
      const response = new CannotSatisfyRequest(rpcId)

      await peerNetwork.peerManager.onMessage.emitAsync(peer, { peerIdentity, message })

      expect(sendSpy).toHaveBeenCalledWith(response)
    })

    it('responds with CannotSatisfy on missing hash', async () => {
      const { peerNetwork } = nodeTest

      const { peer } = getConnectedPeer(peerNetwork.peerManager)
      const peerIdentity = peer.getIdentityOrThrow()

      const sendSpy = jest.spyOn(peer, 'send')

      const rpcId = 432
      const message = new GetCompactBlockRequest(Buffer.alloc(32, 1), rpcId)
      const response = new CannotSatisfyRequest(rpcId)

      await peerNetwork.peerManager.onMessage.emitAsync(peer, { peerIdentity, message })

      expect(sendSpy).toHaveBeenCalledWith(response)
    })
  })

  describe('handles requests for block transactions', () => {
    const nodeTest = createNodeTest()

    it('should respond to GetBlockTransactionsRequest', async () => {
      const { peerNetwork, node } = nodeTest

      const account = await useAccountFixture(node.accounts, 'accountA')
      const block = await useMinerBlockFixture(node.chain, undefined, account, node.accounts)
      const transaction1 = block.transactions[0]
      const transaction2 = await useMinersTxFixture(node.accounts, account)
      const transaction3 = await useMinersTxFixture(node.accounts, account)

      await expect(node.chain).toAddBlock(block)

      await node.chain.transactions.put(block.header.hash, {
        transactions: [transaction1, transaction2, transaction3],
      })

      const { peer } = getConnectedPeer(peerNetwork.peerManager)
      const peerIdentity = peer.getIdentityOrThrow()

      const sendSpy = jest.spyOn(peer, 'send')

      const rpcId = 432
      const message = new GetBlockTransactionsRequest(block.header.hash, [0, 1], rpcId)
      const response = new GetBlockTransactionsResponse(
        block.header.hash,
        [transaction1.serialize(), transaction3.serialize()],
        rpcId,
      )

      await peerNetwork.peerManager.onMessage.emitAsync(peer, { peerIdentity, message })

      expect(sendSpy).toHaveBeenCalledWith(response)
    })

    it('responds with CannotSatisfy when requesting transactions from an old block', async () => {
      const { peerNetwork, node } = nodeTest

      const account = await useAccountFixture(node.accounts, 'accountA')
      for (let i = 0; i < 11; i++) {
        const block = await useMinerBlockFixture(node.chain, undefined, account, node.accounts)
        await expect(node.chain).toAddBlock(block)
      }

      const { peer } = getConnectedPeer(peerNetwork.peerManager)
      const peerIdentity = peer.getIdentityOrThrow()

      const sendSpy = jest.spyOn(peer, 'send')

      const rpcId = 432
      const message = new GetBlockTransactionsRequest(node.chain.genesis.hash, [0], rpcId)
      const response = new CannotSatisfyRequest(rpcId)

      await peerNetwork.peerManager.onMessage.emitAsync(peer, { peerIdentity, message })

      expect(sendSpy).toHaveBeenCalledWith(response)
    })

    it('responds with CannotSatisfy on missing hash', async () => {
      const { peerNetwork } = nodeTest

      const { peer } = getConnectedPeer(peerNetwork.peerManager)
      const peerIdentity = peer.getIdentityOrThrow()

      const sendSpy = jest.spyOn(peer, 'send')

      const rpcId = 432
      const message = new GetBlockTransactionsRequest(Buffer.alloc(32, 1), [0, 1], rpcId)
      const response = new CannotSatisfyRequest(rpcId)

      await peerNetwork.peerManager.onMessage.emitAsync(peer, { peerIdentity, message })

      expect(sendSpy).toHaveBeenCalledWith(response)
    })

    it('responds with CannotSatisfy when requesting transactions past the end of the block', async () => {
      const { peerNetwork, node } = nodeTest

      const { peer } = getConnectedPeer(peerNetwork.peerManager)
      const peerIdentity = peer.getIdentityOrThrow()

      const sendSpy = jest.spyOn(peer, 'send')

      const rpcId = 432
      const genesisBlock = await node.chain.getBlock(node.chain.genesis.hash)
      Assert.isNotNull(genesisBlock)

      const message = new GetBlockTransactionsRequest(
        node.chain.genesis.hash,
        [genesisBlock.transactions.length + 1],
        rpcId,
      )
      const response = new CannotSatisfyRequest(rpcId)

      await peerNetwork.peerManager.onMessage.emitAsync(peer, { peerIdentity, message })

      expect(sendSpy).toHaveBeenCalledWith(response)
    })

    it('responds with CannotSatisfy when requesting transactions with negative indexes', async () => {
      const { peerNetwork, node } = nodeTest

      const { peer } = getConnectedPeer(peerNetwork.peerManager)
      const peerIdentity = peer.getIdentityOrThrow()

      const sendSpy = jest.spyOn(peer, 'send')

      const rpcId = 432
      const message = new GetBlockTransactionsRequest(node.chain.genesis.hash, [-1], rpcId)
      const response = new CannotSatisfyRequest(rpcId)

      await peerNetwork.peerManager.onMessage.emitAsync(peer, { peerIdentity, message })

      expect(sendSpy).toHaveBeenCalledWith(response)
    })
  })

  describe('when enable syncing is true', () => {
    const nodeTest = createNodeTest()

    describe('handles new blocks', () => {
      it('adds new blocks', async () => {
        const { peerNetwork, chain } = nodeTest

        const block = await useMinerBlockFixture(chain)

        expect(await chain.hasBlock(block.header.hash)).toBe(false)

        const { peer } = getConnectedPeer(peerNetwork.peerManager)

        const serializedBlock = BlockSerde.serialize(block)
        await peerNetwork.peerManager.onMessage.emitAsync(
          ...peerMessage(peer, new NewBlockMessage(serializedBlock)),
        )

        expect(await chain.hasBlock(block.header.hash)).toBe(true)
      })

      it('does not sync or gossip invalid blocks', async () => {
        const { peerNetwork, node } = nodeTest
        const { chain } = node

        const block = await useMinerBlockFixture(chain)
        const prevBlock = await chain.getBlock(block.header.previousBlockHash)
        if (prevBlock === null) {
          throw new Error('prevBlock should be in chain')
        }

        const changes: ((block: Block) => {
          block: SerializedCompactBlock
          reason: VerificationResultReason
        })[] = [
          (b: Block) => {
            const newBlock = b.toCompactBlock()
            newBlock.header.sequence = 999
            return { block: newBlock, reason: VerificationResultReason.SEQUENCE_OUT_OF_ORDER }
          },
          (b: Block) => {
            const newBlock = b.toCompactBlock()
            newBlock.header.timestamp = 8640000000000000
            return { block: newBlock, reason: VerificationResultReason.TOO_FAR_IN_FUTURE }
          },
        ]

        for (const change of changes) {
          const { block: invalidBlock, reason } = change(block)

          const peers = getConnectedPeersWithSpies(peerNetwork.peerManager, 1)
          await peerNetwork.peerManager.onMessage.emitAsync(
            ...peerMessage(peers[0].peer, new NewBlockV2Message(invalidBlock)),
          )

          // Peers should not be sent invalid block
          for (const { sendSpy } of peers) {
            expect(sendSpy).not.toHaveBeenCalled()
          }

          const invalidHeader = BlockHeaderSerde.deserialize(invalidBlock.header)
          await expect(chain.hasBlock(invalidHeader.hash)).resolves.toBe(false)
          expect(chain.isInvalid(invalidHeader)).toBe(reason)
        }
      })

      it('broadcasts a new block when it is created', async () => {
        const { peerNetwork, node, chain } = nodeTest

        const block = await useMinerBlockFixture(chain)

        // Create 10 peers on the current version
        const peers = getConnectedPeersWithSpies(peerNetwork.peerManager, 10)
        for (const { peer } of peers) {
          peer.version = VERSION_PROTOCOL
        }

        await node.miningManager.onNewBlock.emitAsync(block)

        const sentHash = peers.filter(({ sendSpy }) => {
          return (
            sendSpy.mock.calls.filter(([message]) => {
              return message instanceof NewBlockHashesMessage
            }).length > 0
          )
        })

        const sentNewBlockV2 = peers.filter(({ sendSpy }) => {
          const hashCalls = sendSpy.mock.calls.filter(([message]) => {
            return message instanceof NewBlockV2Message
          })
          return hashCalls.length > 0
        })

        expect(sentHash.length).toBe(7)
        expect(sentNewBlockV2.length).toBe(3)
      })

      it('broadcasts a new block but does not send new messages to old peers', async () => {
        const { peerNetwork, node, chain } = nodeTest

        const block = await useMinerBlockFixture(chain)

        // Create 10 peers on the current version
        const newPeers = getConnectedPeersWithSpies(peerNetwork.peerManager, 10)
        for (const { peer } of newPeers) {
          peer.version = VERSION_PROTOCOL
        }

        // Create 10 peers on an old version
        const oldPeers = getConnectedPeersWithSpies(peerNetwork.peerManager, 10)
        for (const { peer } of oldPeers) {
          peer.version = 17 // version that does not accept block hashes
        }

        await node.miningManager.onNewBlock.emitAsync(block)

        const sentHash = oldPeers.filter(({ sendSpy }) => {
          return (
            sendSpy.mock.calls.filter(([message]) => {
              return message instanceof NewBlockHashesMessage
            }).length > 0
          )
        })

        const sentNewBlockV2 = oldPeers.filter(({ sendSpy }) => {
          const hashCalls = sendSpy.mock.calls.filter(([message]) => {
            return message instanceof NewBlockV2Message
          })
          return hashCalls.length > 0
        })

        const sentNewBlock = oldPeers.filter(({ sendSpy }) => {
          const hashCalls = sendSpy.mock.calls.filter(([message]) => {
            return message instanceof NewBlockMessage
          })
          return hashCalls.length > 0
        })

        // None of the old peers should send new messages, only the old messages
        expect(sentHash.length).toBe(0)
        expect(sentNewBlockV2.length).toBe(0)
        expect(sentNewBlock.length).toBe(10)

        // All of the new peers got hashes since the old peers took up full block slots
        const sentHashNew = newPeers.filter(({ sendSpy }) => {
          return (
            sendSpy.mock.calls.filter(([message]) => {
              return message instanceof NewBlockHashesMessage
            }).length > 0
          )
        })

        expect(sentHashNew.length).toBe(10)
      })
    })

    describe('handles requests for mempool transactions', () => {
      it('should respond to PooledTransactionsRequest', async () => {
        const { peerNetwork, node } = nodeTest

        const { accounts, memPool } = node
        const accountA = await useAccountFixture(accounts, 'accountA')
        const accountB = await useAccountFixture(accounts, 'accountB')
        const { transaction } = await useBlockWithTx(node, accountA, accountB)
        memPool.acceptTransaction(transaction)

        const { peer, sendSpy } = getConnectedPeersWithSpies(peerNetwork.peerManager, 1)[0]

        const rpcId = 432
        const message = new PooledTransactionsRequest([transaction.hash()], rpcId)
        const response = new PooledTransactionsResponse([transaction.serialize()], rpcId)

        peerNetwork.peerManager.onMessage.emit(peer, {
          peerIdentity: peer.getIdentityOrThrow(),
          message,
        })

        expect(sendSpy).toHaveBeenCalledWith(response)
      })
    })

    describe('handles new transactions', () => {
      it('does not accept or sync transactions when the worker pool is saturated', async () => {
        const { peerNetwork, workerPool, accounts, node } = nodeTest
        const { memPool } = node

        const accountA = await useAccountFixture(accounts, 'accountA')
        const accountB = await useAccountFixture(accounts, 'accountB')
        const { transaction } = await useBlockWithTx(node, accountA, accountB)

        Object.defineProperty(workerPool, 'saturated', { get: () => true })

        const syncTransaction = jest.spyOn(accounts, 'syncTransaction')

        const peers = getConnectedPeersWithSpies(peerNetwork.peerManager, 5)
        const { peer: peerWithTransaction } = peers[0]

        await peerNetwork.peerManager.onMessage.emitAsync(peerWithTransaction, {
          peerIdentity: peerWithTransaction.getIdentityOrThrow(),
          message: new NewTransactionMessage(transaction.serialize()),
        })

        for (const { sendSpy } of peers) {
          expect(sendSpy).not.toHaveBeenCalled()
        }

        expect(memPool.exists(transaction.hash())).toBe(false)
        expect(syncTransaction).not.toHaveBeenCalled()
      })

      it('does not accept or sync transactions when the node is syncing', async () => {
        const { peerNetwork, node } = nodeTest

        const { accounts, memPool, chain } = node
        const accountA = await useAccountFixture(accounts, 'accountA')
        const accountB = await useAccountFixture(accounts, 'accountB')
        const { transaction } = await useBlockWithTx(node, accountA, accountB)

        chain.synced = false

        const syncTransaction = jest.spyOn(accounts, 'syncTransaction')

        const peers = getConnectedPeersWithSpies(peerNetwork.peerManager, 5)
        const { peer: peerWithTransaction } = peers[0]

        await peerNetwork.peerManager.onMessage.emitAsync(peerWithTransaction, {
          peerIdentity: peerWithTransaction.getIdentityOrThrow(),
          message: new NewTransactionMessage(transaction.serialize()),
        })

        for (const { sendSpy } of peers) {
          expect(sendSpy).not.toHaveBeenCalled()
        }

        expect(memPool.exists(transaction.hash())).toBe(false)
        expect(syncTransaction).not.toHaveBeenCalled()
      })

      it('verifies and syncs the same transaction once', async () => {
        const { peerNetwork, node } = nodeTest
        const { accounts, memPool, chain } = node

        chain.synced = true
        const accountA = await useAccountFixture(accounts, 'accountA')
        const accountB = await useAccountFixture(accounts, 'accountB')
        const { transaction } = await useBlockWithTx(node, accountA, accountB)

        const verifyNewTransactionSpy = jest.spyOn(node.chain.verifier, 'verifyNewTransaction')

        const syncTransaction = jest.spyOn(node.accounts, 'syncTransaction')

        const peers = getConnectedPeersWithSpies(peerNetwork.peerManager, 5)
        const { peer: peerWithTransaction } = peers[0]
        const peersWithoutTransaction = peers.slice(1)

        await peerNetwork.peerManager.onMessage.emitAsync(peerWithTransaction, {
          peerIdentity: peerWithTransaction.getIdentityOrThrow(),
          message: new NewTransactionMessage(transaction.serialize()),
        })

        for (const { sendSpy } of peersWithoutTransaction) {
          const transactionMessages = sendSpy.mock.calls.filter(([message]) => {
            return (
              message instanceof NewTransactionMessage ||
              message instanceof NewTransactionV2Message ||
              message instanceof NewPooledTransactionHashes
            )
          })
          expect(transactionMessages).toHaveLength(1)
        }

        expect(verifyNewTransactionSpy).toHaveBeenCalledTimes(1)

        expect(memPool.exists(transaction.hash())).toBe(true)

        expect(syncTransaction).toHaveBeenCalledTimes(1)

        for (const { peer } of peers) {
          expect(peer.state.identity).not.toBeNull()
          peer.state.identity &&
            expect(peerNetwork.knowsTransaction(transaction.hash(), peer.state.identity)).toBe(
              true,
            )
        }

        const { peer: peerWithTransaction2 } = peers[1]
        await peerNetwork.peerManager.onMessage.emitAsync(peerWithTransaction2, {
          peerIdentity: peerWithTransaction2.getIdentityOrThrow(),
          message: new NewTransactionMessage(transaction.serialize()),
        })

        // These functions should still only be called once
        for (const { sendSpy } of peersWithoutTransaction) {
          const transactionMessages = sendSpy.mock.calls.filter(([message]) => {
            return (
              message instanceof NewTransactionMessage ||
              message instanceof NewTransactionV2Message ||
              message instanceof NewPooledTransactionHashes
            )
          })
          expect(transactionMessages).toHaveLength(1)
        }

        expect(verifyNewTransactionSpy).toHaveBeenCalledTimes(1)

        expect(memPool.exists(transaction.hash())).toBe(true)

        expect(syncTransaction).toHaveBeenCalledTimes(1)
      })

      it('does not sync or gossip double-spent transactions', async () => {
        const { peerNetwork, node } = nodeTest
        const { accounts, memPool, chain } = node

        chain.synced = true

        const accountA = await useAccountFixture(accounts, 'accountA')
        const accountB = await useAccountFixture(accounts, 'accountB')
        const { transaction } = await useBlockWithTx(node, accountA, accountB)
        const verifyNewTransactionSpy = jest.spyOn(node.chain.verifier, 'verifyNewTransaction')

        const spend = transaction.getSpend(0)
        await node.chain.nullifiers.add(spend.nullifier)

        const acceptTransaction = jest.spyOn(node.memPool, 'acceptTransaction')
        const syncTransaction = jest.spyOn(node.accounts, 'syncTransaction')

        const peers = getConnectedPeersWithSpies(peerNetwork.peerManager, 5)
        const { peer: peerWithTransaction } = peers[0]
        const peersWithoutTransaction = peers.slice(1)

        await peerNetwork.peerManager.onMessage.emitAsync(peerWithTransaction, {
          peerIdentity: peerWithTransaction.getIdentityOrThrow(),
          message: new NewTransactionMessage(transaction.serialize()),
        })

        // Peers should not be sent invalid transaction
        for (const { sendSpy } of peers) {
          expect(sendSpy).not.toHaveBeenCalled()
        }

        expect(verifyNewTransactionSpy).toHaveBeenCalledTimes(1)
        const verificationResult = await verifyNewTransactionSpy.mock.results[0].value
        expect(verificationResult).toEqual({
          valid: false,
          reason: VerificationResultReason.DOUBLE_SPEND,
        })

        expect(memPool.exists(transaction.hash())).toBe(false)
        expect(acceptTransaction).not.toHaveBeenCalled()

        expect(syncTransaction).not.toHaveBeenCalled()

        // Peer that were not sent transaction should not be marked
        for (const { peer } of peersWithoutTransaction) {
          expect(peer.state.identity).not.toBeNull()
          peer.state.identity &&
            expect(peerNetwork.knowsTransaction(transaction.hash(), peer.state.identity)).toBe(
              false,
            )
        }

        // Peer that sent the transaction should have it marked
        expect(peerWithTransaction.state.identity).not.toBeNull()
        peerWithTransaction.state.identity &&
          expect(
            peerNetwork.knowsTransaction(
              transaction.hash(),
              peerWithTransaction.state.identity,
            ),
          ).toBe(true)
      })

      it('syncs transactions if the spends reference a larger tree size', async () => {
        const { peerNetwork, node } = nodeTest
        const { accounts, memPool, chain } = node

        chain.synced = true

        const accountA = await useAccountFixture(accounts, 'accountA')
        const accountB = await useAccountFixture(accounts, 'accountB')
        const { transaction } = await useBlockWithTx(node, accountA, accountB)

        await node.chain.notes.truncate(0)
        await node.chain.nullifiers.truncate(0)

        const verifyNewTransactionSpy = jest.spyOn(node.chain.verifier, 'verifyNewTransaction')
        const syncTransaction = jest.spyOn(node.accounts, 'syncTransaction')

        const peers = getConnectedPeersWithSpies(peerNetwork.peerManager, 5)
        const { peer: peerWithTransaction } = peers[0]
        const peersWithoutTransaction = peers.slice(1)

        await peerNetwork.peerManager.onMessage.emitAsync(peerWithTransaction, {
          peerIdentity: peerWithTransaction.getIdentityOrThrow(),
          message: new NewTransactionMessage(transaction.serialize()),
        })

        expect(verifyNewTransactionSpy).toHaveBeenCalledTimes(1)
        const verificationResult = await verifyNewTransactionSpy.mock.results[0].value
        expect(verificationResult).toEqual({
          valid: true,
        })

        expect(memPool.exists(transaction.hash())).toBe(true)
        expect(syncTransaction).toHaveBeenCalledTimes(1)
        for (const { sendSpy } of peersWithoutTransaction) {
          const transactionMessages = sendSpy.mock.calls.filter(([message]) => {
            return (
              message instanceof NewTransactionMessage ||
              message instanceof NewTransactionV2Message ||
              message instanceof NewPooledTransactionHashes
            )
          })
          expect(transactionMessages).toHaveLength(1)
        }
      })

      it('does not sync or gossip invalid transactions', async () => {
        const { peerNetwork, node } = nodeTest
        const { accounts, memPool, chain } = node

        chain.synced = true

        const accountA = await useAccountFixture(accounts, 'accountA')
        const accountB = await useAccountFixture(accounts, 'accountB')
        const fixture = await useBlockWithTx(node, accountA, accountB)

        const transactionBuffer = Buffer.from(fixture.transaction.serialize())
        // make the transaction invalid somehow
        transactionBuffer.writeUInt8(0xff, transactionBuffer.byteLength - 2)
        const transaction = new Transaction(transactionBuffer)

        const verifyNewTransactionSpy = jest.spyOn(node.chain.verifier, 'verifyNewTransaction')

        const acceptTransaction = jest.spyOn(node.memPool, 'acceptTransaction')
        const syncTransaction = jest.spyOn(node.accounts, 'syncTransaction')

        const peers = getConnectedPeersWithSpies(peerNetwork.peerManager, 5)
        const { peer: peerWithTransaction } = peers[0]
        const peersWithoutTransaction = peers.slice(1)

        await peerNetwork.peerManager.onMessage.emitAsync(peerWithTransaction, {
          peerIdentity: peerWithTransaction.getIdentityOrThrow(),
          message: new NewTransactionMessage(transaction.serialize()),
        })

        // Peers should not be sent invalid transaction
        for (const { sendSpy } of peers) {
          expect(sendSpy).not.toHaveBeenCalled()
        }

        expect(verifyNewTransactionSpy).toHaveBeenCalledTimes(1)
        const verificationResult = await verifyNewTransactionSpy.mock.results[0].value
        expect(verificationResult).toEqual({
          valid: false,
          reason: VerificationResultReason.ERROR,
        })

        expect(memPool.exists(transaction.hash())).toBe(false)
        expect(acceptTransaction).not.toHaveBeenCalled()

        expect(syncTransaction).not.toHaveBeenCalled()

        // Peer that were not sent transaction should not be marked
        for (const { peer } of peersWithoutTransaction) {
          expect(peer.state.identity).not.toBeNull()
          peer.state.identity &&
            expect(peerNetwork.knowsTransaction(transaction.hash(), peer.state.identity)).toBe(
              false,
            )
        }

        // Peer that sent the transaction should have it marked
        expect(peerWithTransaction.state.identity).not.toBeNull()
        peerWithTransaction.state.identity &&
          expect(
            peerNetwork.knowsTransaction(
              transaction.hash(),
              peerWithTransaction.state.identity,
            ),
          ).toBe(true)
      })

      it('broadcasts a new transaction when it is created', async () => {
        const { peerNetwork, node, accounts } = nodeTest

        // Create 10 peers on the current version
        const peers = getConnectedPeersWithSpies(peerNetwork.peerManager, 10)
        for (const { peer } of peers) {
          peer.version = VERSION_PROTOCOL
        }

        const accountA = await useAccountFixture(accounts, 'accountA')
        const accountB = await useAccountFixture(accounts, 'accountB')
        const { transaction } = await useBlockWithTx(node, accountA, accountB)

        await accounts.onBroadcastTransaction.emitAsync(transaction)

        const sentHash = peers.filter(({ sendSpy }) => {
          return (
            sendSpy.mock.calls.filter(([message]) => {
              return message instanceof NewPooledTransactionHashes
            }).length > 0
          )
        })

        const sentFullV2Transaction = peers.filter(({ sendSpy }) => {
          const hashCalls = sendSpy.mock.calls.filter(([message]) => {
            return message instanceof NewTransactionV2Message
          })
          return hashCalls.length > 0
        })

        expect(sentHash.length).toBe(7)
        expect(sentFullV2Transaction.length).toBe(3)
      })

      it('broadcasts a new transaction but does not send new messages to old peers', async () => {
        const { peerNetwork, node, accounts } = nodeTest

        // Create 10 peers on the current version
        const newPeers = getConnectedPeersWithSpies(peerNetwork.peerManager, 10)
        for (const { peer } of newPeers) {
          peer.version = VERSION_PROTOCOL
        }

        // Create 10 peers on an old version
        const oldPeers = getConnectedPeersWithSpies(peerNetwork.peerManager, 10)
        for (const { peer } of oldPeers) {
          peer.version = 16 // version that does not accept transaction hashes
        }

        const accountA = await useAccountFixture(accounts, 'accountA')
        const accountB = await useAccountFixture(accounts, 'accountB')
        const { transaction } = await useBlockWithTx(node, accountA, accountB)

        await accounts.onBroadcastTransaction.emitAsync(transaction)

        const sentHash = oldPeers.filter(({ sendSpy }) => {
          return (
            sendSpy.mock.calls.filter(([message]) => {
              return message instanceof NewPooledTransactionHashes
            }).length > 0
          )
        })

        const sentFullV2Transaction = oldPeers.filter(({ sendSpy }) => {
          const hashCalls = sendSpy.mock.calls.filter(([message]) => {
            return message instanceof NewTransactionV2Message
          })
          return hashCalls.length > 0
        })

        const sentFullTransaction = oldPeers.filter(({ sendSpy }) => {
          const hashCalls = sendSpy.mock.calls.filter(([message]) => {
            return message instanceof NewTransactionMessage
          })
          return hashCalls.length > 0
        })

        // None of the old peers should send new messages, only the old messages
        expect(sentHash.length).toBe(0)
        expect(sentFullV2Transaction.length).toBe(0)
        expect(sentFullTransaction.length).toBe(10)

        // All of the new peers got hashes since the old peers took up full transaction slots
        const sentHashNew = newPeers.filter(({ sendSpy }) => {
          return (
            sendSpy.mock.calls.filter(([message]) => {
              return message instanceof NewPooledTransactionHashes
            }).length > 0
          )
        })

        expect(sentHashNew.length).toBe(10)
      })
    })
  })

  describe('when enable syncing is false', () => {
    const nodeTest = createNodeTest(false, { config: { enableSyncing: false } })

    it('does not handle blocks', async () => {
      const { peerNetwork, node, chain } = nodeTest
      chain.synced = false

      const { peer } = getConnectedPeer(peerNetwork.peerManager)

      const block = {
        header: {
          graffiti: 'chipotle',
          minersFee: '0',
          noteCommitment: {
            commitment: Buffer.from('commitment'),
            size: 1,
          },
          nullifierCommitment: {
            commitment: 'commitment',
            size: 2,
          },
          previousBlockHash: 'burrito',
          randomness: '1',
          sequence: 2,
          target: 'icecream',
          timestamp: 200000,
          work: '123',
          hash: 'ramen',
        },
        transactions: [],
      }

      jest.spyOn(node.syncer, 'addBlock')

      await peerNetwork['handleNewBlockMessage'](
        peer,
        new NewBlockMessage(block, Buffer.alloc(16, 'nonce')),
      )

      expect(node.syncer.addBlock).not.toHaveBeenCalled()
    })

    it('does not handle transactions', async () => {
      const { peerNetwork, node, chain } = nodeTest
      chain.synced = false

      const { accounts, memPool } = node
      const accountA = await useAccountFixture(accounts, 'accountA')
      const accountB = await useAccountFixture(accounts, 'accountB')
      const { transaction } = await useBlockWithTx(node, accountA, accountB)

      const peers = getConnectedPeersWithSpies(peerNetwork.peerManager, 2)

      const { sendSpy } = peers[0] // peer without transaction
      const { peer: peerWithTransaction } = peers[1]

      jest.spyOn(chain.verifier, 'verifyNewTransaction')
      jest.spyOn(memPool, 'acceptTransaction')

      await peerNetwork.peerManager.onMessage.emitAsync(peerWithTransaction, {
        peerIdentity: peerWithTransaction.getIdentityOrThrow(),
        message: new NewTransactionMessage(transaction.serialize()),
      })

      expect(sendSpy).not.toHaveBeenCalled()
      expect(chain.verifier.verifyNewTransaction).not.toHaveBeenCalled()
      expect(memPool.acceptTransaction).not.toHaveBeenCalled()
    })
  })
})
